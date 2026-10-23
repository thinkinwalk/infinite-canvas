import { afterEach, expect, test } from "bun:test";
import { configForFeature, defaultConfig, managedEffectiveConfig, modelAdapter, modelMatchesCapability, modelOptionLabel, modelRequestHeaders, selectableModelsByCapability, useConfigStore } from "../src/stores/use-config-store";
import { useUserStore } from "../src/stores/use-user-store";
import { modelFeatureForPath } from "../src/lib/model-feature";
import { videoProfile } from "../src/lib/video-capabilities";
import { createReplicateTask, quoteReplicate } from "../src/services/api/replicate";
import type { PublicManagedCatalog } from "../src/services/api/model-management";
import { managedFixedHeaders, quoteManagedFixed } from "../src/services/api/model-management";
import { requestAudioGeneration } from "../src/services/api/audio";
import { storeVideoConfig, storeVideoSettings } from "../src/pages/video-tool/store-explore-request";
import { viralVideoConfig } from "../src/pages/video-tool/viral-recreate-request";
import { emptyVideoDraft } from "../src/types/video-workbench";

const catalog: PublicManagedCatalog = {
    enabled:true,revision:12,features:[],
    models:[
        {id:"model_h3",label:"流光",description:"多素材",capability:"video"},
        {id:"model_wan",label:"人物创作",description:"",capability:"video"},
        {id:"model_speech",label:"自然配音",description:"",capability:"audio"},
    ],
    bindings:[
        {featureId:"video.generate",modelId:"model_h3",available:true,default:true,order:0,operations:["video"],adapter:"video.sparkcine_h3",credits:20,video:{displayName:"流光",description:"",interface:"sparkcine_h3",resolutions:["720"],seconds:["5"],inputModes:["reference"],maxImages:9,maxVideos:1,maxAudios:3,generateAudio:false}},
        {featureId:"replace.person",modelId:"model_wan",available:true,default:true,order:1,operations:["replace-person"],adapter:"cloud:replace-person",credits:40},
        {featureId:"digital-human.speech",modelId:"model_speech",available:true,default:true,order:0,operations:["speech"],adapter:"cloud:speech",credits:5},
    ],
};
const originalFetch = globalThis.fetch;
const originalConfig = useConfigStore.getState();
const originalUser = useUserStore.getState();
afterEach(() => { globalThis.fetch=originalFetch;useConfigStore.setState(originalConfig);useUserStore.setState(originalUser); });

test("feature bindings isolate defaults and reject a retired model selection", () => {
    const generation = managedEffectiveConfig({...defaultConfig,channelMode:"remote"},catalog,{video:"video.generate"},{"video.generate":"remote::model_h3","replace.person":"remote::model_h3"});
    expect(generation.videoModel).toBe("remote::model_h3");
    const replacement = configForFeature(generation,"replace.person","video");
    expect(replacement.videoModel).toBe("remote::model_wan");
    expect(selectableModelsByCapability(replacement,"video")).toEqual(["remote::model_wan"]);
    expect(modelMatchesCapability(replacement,"remote::model_h3","video")).toBe(false);
    expect(modelRequestHeaders(replacement,"video")).toEqual({"X-Model-Feature":"replace.person","X-Model-Revision":"12"});
    const unavailable = configForFeature(generation,"replace.head","video");
    expect(unavailable.videoModel).toBe("");
    expect(selectableModelsByCapability(unavailable,"video")).toEqual([]);
});

test("aliases do not determine adapters or capabilities", () => {
    const config = managedEffectiveConfig({...defaultConfig,channelMode:"remote"},catalog,{video:"video.generate"});
    expect(modelOptionLabel(config,config.videoModel)).toBe("流光");
    expect(videoProfile(config,config.videoModel).interface).toBe("sparkcine_h3");
    expect(modelAdapter(config.videoModel,config)).toBe("video.sparkcine_h3");
    const renamed = {...catalog,models:catalog.models.map((m) => ({...m,label:"完全不同的名称"}))};
    const next = managedEffectiveConfig(config,renamed,{video:"video.generate"});
    expect(next.videoModel).toBe(config.videoModel);
    expect(modelAdapter(next.videoModel,next)).toBe("video.sparkcine_h3");
    expect(modelOptionLabel(next,next.videoModel)).toBe("完全不同的名称 · model_h3");
});

test("workbench steps choose independent feature identities", () => {
    expect(modelFeatureForPath("/video/content-replace","video",{replacement:"background"})).toBe("replace.background");
    expect(modelFeatureForPath("/video/content-replace","video",{replacement:"person",replacementModel:"headswap"})).toBe("replace.head");
    expect(modelFeatureForPath("/digital-human","audio",{speechMode:"voice_clone"})).toBe("digital-human.clone");
    expect(modelFeatureForPath("/digital-human","video",{digitalHumanMode:"video"})).toBe("digital-human.lipsync");
    expect(modelFeatureForPath("/canvas/example","text")).toBe("canvas.text");
});

test("cloud submission carries the exact selected model, feature and signed quote", async () => {
    useConfigStore.setState({featureModels:{"digital-human.speech":"remote::model_speech"}});
    useUserStore.setState({token:"managed-test"});
    const config = managedEffectiveConfig({...defaultConfig,channelMode:"remote"},catalog,{audio:"digital-human.speech"});
    const events: Record<string,unknown>[] = [];
    globalThis.fetch = async (_url,init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        events.push(body);
        return new Response(JSON.stringify({code:0,data:body.id ? {id:body.id,status:"running"} : {credits:5,available:true,quoteToken:"signed-proof"}}),{headers:{"Content-Type":"application/json"}});
    };
    const input = {text:"你好",mode:"custom_voice",speaker:"Vivian"};
    const quote = await quoteReplicate("speech",input,undefined,{config,model:"remote::model_speech",featureId:"digital-human.speech"});
    await createReplicateTask("task-managed","speech",input,quote.credits,undefined,{config,model:"remote::model_speech",featureId:"digital-human.speech"});
    expect(events[0]).toMatchObject({modelId:"model_speech",featureId:"digital-human.speech"});
    expect(events[1]).toMatchObject({modelId:"model_speech",featureId:"digital-human.speech",quoteToken:"signed-proof",expectedCredits:5});
    const blocked = {...config,managed:{...catalog,bindings:[]}};
    await expect(quoteReplicate("speech",input,undefined,{config:blocked,model:"remote::model_speech",featureId:"digital-human.speech"})).rejects.toThrow("没有可用模型");
});

test("fixed quotes preserve the confirmed route and separate quantity, revision and session", async () => {
    useUserStore.setState({token:"fixed-test"});
    const config = {...managedEffectiveConfig({...defaultConfig,channelMode:"remote"},catalog,{video:"video.generate"}),model:"model_h3"};
    let calls = 0;
    globalThis.fetch = async (_url,init) => {
        calls++;
        const input = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({code:0,data:{credits:input.count * 3,calculation:"fixed",quoteToken:`proof-${calls}`}}),{headers:{"Content-Type":"application/json"}});
    };
    const first = await quoteManagedFixed(config,"image",2);
    expect(await managedFixedHeaders(config,"image",2)).toEqual({"X-Model-Quote":first.quoteToken,"X-Expected-Credits":"6"});
    expect(calls).toBe(1);
    await managedFixedHeaders(config,"image",1);
    await managedFixedHeaders({...config,managed:{...catalog,revision:13}},"image",2);
    useUserStore.setState({token:"different-session"});
    await managedFixedHeaders(config,"image",2);
    expect(calls).toBe(4);
    useUserStore.setState({user:{...originalUser.user,group:"VIP"} as NonNullable<typeof originalUser.user>});
    await managedFixedHeaders(config,"image",2);
    expect(calls).toBe(5);
});

test("canvas audio follows the selected speech adapter and restores without a second charge", async () => {
    useUserStore.setState({token:"audio-test"});
    const audioCatalog = {...catalog,bindings:[{...catalog.bindings[2],featureId:"canvas.audio"}]};
    const config = configForFeature(managedEffectiveConfig({...defaultConfig,channelMode:"remote"},audioCatalog,{audio:"canvas.audio"}),"canvas.audio","audio");
    const events: string[] = [];
    globalThis.fetch = async (url,init) => {
        const path = String(url);
        if (path.endsWith("/quote")) {
            expect(JSON.parse(String(init?.body)).input.speaker).toBe("Vivian");
            events.push("quote");return new Response(JSON.stringify({code:0,data:{credits:5,available:true,quoteToken:"proof"}}));
        }
        if (path.endsWith("/tasks") && init?.method === "POST") {events.push("create");return new Response(JSON.stringify({code:0,data:{id:"speech-task"}}));}
        if (path.endsWith("/content")) {events.push("download");return new Response("audio",{headers:{"Content-Type":"audio/wav"}});}
        if (path.includes("/tasks/")) {events.push("poll");return new Response(JSON.stringify({code:0,data:{id:"speech-task",status:"completed"}}));}
        return new Response(JSON.stringify({code:0,data:{}}));
    };
    const audio = await requestAudioGeneration(config,"你好",{confirmReplicate:async () => {events.push("confirm");},onTaskSubmitted:async () => {events.push("persist");}});
    expect(audio.type).toBe("audio/wav");
    expect(events).toEqual(["quote","confirm","persist","create","poll","download"]);
    events.length = 0;
    await requestAudioGeneration(config,"你好",{existingTaskId:"speech-task"});
    expect(events).toEqual(["poll","download"]);
});

test("audio recovery releases confirmed failures and retains uncertain task identity", async () => {
    useUserStore.setState({token:"audio-recovery-test"});
    for (const status of ["failed","cancelled","uncertain"] as const) {
        const failed: string[] = [];
        globalThis.fetch = async () => new Response(JSON.stringify({code:0,data:{id:"existing-speech",status,error:"任务未完成"}}));
        await expect(requestAudioGeneration(defaultConfig,"你好",{existingTaskId:"existing-speech",onTaskFailed:(id) => {failed.push(id);}})).rejects.toThrow("任务未完成");
        expect(failed).toEqual(status === "uncertain" ? [] : ["existing-speech"]);
    }
});

test("store and viral drafts repair retired models and invalid specs without changing source drafts", () => {
    const bindings = ["store-explore.video","viral-recreate.video"].map((featureId) => ({...catalog.bindings[0],featureId}));
    const scopedCatalog = {...catalog,bindings};
    for (const tool of ["store-explore","viral-recreate"] as const) {
        const config = configForFeature(managedEffectiveConfig({...defaultConfig,channelMode:"remote"},scopedCatalog,{video:`${tool}.video`}),`${tool}.video`,"video");
        const settings = {...storeVideoSettings(config),videoModel:"remote::removed",vquality:"4k",videoSeconds:"99"};
        const draft = {...emptyVideoDraft(tool),storeSettings:settings,viralSettings:settings};
        const next = tool === "store-explore" ? storeVideoConfig(draft,config) : viralVideoConfig(draft,config);
        expect(next.model).toBe("remote::model_h3");
        expect(next.videoModel).toBe(next.model);
        expect(next.vquality).toBe("720");
        expect(next.videoSeconds).toBe("5");
        expect(settings.videoModel).toBe("remote::removed");
    }
});
