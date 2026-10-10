import { App, Button, Input, Segmented } from "antd";
import { ArrowRight, Clapperboard, ImagePlus, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ModelPicker } from "@/components/model-picker";
import { useVideoCreationConfig } from "@/hooks/use-video-creation-config";
import { useConfigStore } from "@/stores/use-config-store";
import { useHomeDraftStore, type HomeCreationKind } from "@/stores/use-home-draft-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { trackEvent } from "@/lib/analytics";

const kinds = [{ value: "image", icon: ImagePlus }, { value: "video", icon: Clapperboard }, { value: "human", icon: UserRound }] as const;

export function HomeCreationEntry() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const draft = useHomeDraftStore();
    const config = useVideoCreationConfig();
    const { updateConfig, openConfigDialog, publicSettingsError } = useConfigStore();
    const { dispatchImage, dispatchVideo, dispatchHuman } = useWorkbenchAgentStore();
    const humanBusy = useVideoWorkbenchStore((state) => state.busyTools["digital-human"]);
    const { kind, prompts, humanMode, humanCopySource } = draft;
    const continueCreation = (placement: string) => {
        if (kind === "human" && humanBusy) { message.warning(t("home.entry.humanBusy")); return; }
        const prompt = prompts[kind];
        if (kind === "image" && prompt.trim()) dispatchImage({ prompt, run: false });
        if (kind === "video" && prompt.trim()) dispatchVideo({ prompt, run: false });
        if (kind === "human") dispatchHuman({ prompt, mode: humanMode, copySource: humanCopySource });
        trackEvent("home_cta_click", { placement, target: kind });
        navigate(kind === "human" ? "/digital-human" : `/${kind}`);
    };
    const selectKind = (kind: HomeCreationKind) => { draft.setKind(kind); trackEvent("home_creation_select", { target: kind }); };
    const field = kind === "human" ? humanCopySource === "manual" ? "narration" : "brief" : kind;

    return <div id="home-creation" className="mt-6 min-w-0">
        <Segmented block size="large" shape="round" name="home-creation-type" aria-label={t("home.entry.choose")} value={kind} disabled={!draft.hydrated} onChange={(value) => selectKind(value as HomeCreationKind)} options={kinds.map(({ value, icon: Icon }) => ({ value, label: <span className="inline-flex items-center gap-1.5 text-xs sm:text-sm"><Icon className="hidden size-4 sm:block" />{t(`home.entry.${value}.label`)}</span> }))} />
        <div className="mt-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
            {kind === "human" && <div className="mb-3 flex flex-wrap gap-2">
                <Segmented size="small" aria-label={t("home.entry.humanMode")} value={humanMode} disabled={!draft.hydrated} onChange={(value) => draft.setHumanMode(value as "photo" | "video")} options={[{ value: "photo", label: t("home.entry.photo") }, { value: "video", label: t("home.entry.lipsync") }]} />
                <Segmented size="small" aria-label={t("home.entry.copySource")} value={humanCopySource} disabled={!draft.hydrated} onChange={(value) => draft.setHumanCopySource(value as "manual" | "brief")} options={[{ value: "manual", label: t("home.entry.narration.label") }, { value: "brief", label: t("home.entry.brief.label") }]} />
            </div>}
            <label htmlFor="home-creation-prompt" className="mb-2 block text-xs font-medium">{t(`home.entry.${field}.label`)}</label>
            <Input.TextArea id="home-creation-prompt" value={prompts[kind]} disabled={!draft.hydrated} onChange={(event) => draft.setPrompt(kind, event.target.value)} placeholder={t(`home.entry.${field}.placeholder`)} autoSize={{ minRows: 3, maxRows: 7 }} variant="borderless" className="!px-0" />
            <div className="mt-3 border-t border-border pt-3">
                {kind !== "human" ? <ModelPicker config={config} capability={kind} value={kind === "image" ? config.imageModel : config.videoModel} onChange={(model) => updateConfig(kind === "image" ? "imageModel" : "videoModel", model)} onMissingConfig={() => openConfigDialog()} className="!w-full !min-w-0 !rounded-lg !shadow-none" /> : <p className="text-xs leading-5 text-muted-foreground">{t(`home.entry.${humanMode === "photo" ? "photoHint" : "videoHint"}`)}</p>}
                {kind !== "human" && publicSettingsError && <p role="alert" className="mt-2 text-xs text-amber-600 dark:text-amber-400">{t("home.entry.modelUnavailable")}</p>}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <button type="button" disabled={!draft.hydrated} onClick={() => continueCreation("home_materials")} className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:cursor-wait"><ImagePlus className="size-4" />{t(`home.entry.${kind}.materials`)}</button>
                    <Button type="primary" disabled={!draft.hydrated || Boolean(kind === "human" && humanBusy)} onClick={() => continueCreation("home_composer")} icon={<ArrowRight className="size-4" />} iconPlacement="end">{t(`home.entry.${kind}.continue`)}</Button>
                </div>
            </div>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">{t(draft.storageError ? "home.entry.storageError" : "home.entry.saved")} · {t("home.entry.confirmHint")}</p>
    </div>;
}
