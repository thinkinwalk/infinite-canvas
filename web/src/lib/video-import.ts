const platformNames: Record<string, string> = {
    wxchannels: "视频号",
    douyin: "抖音",
    xiaohongshu: "小红书",
    kuaishou: "快手",
    bilibili: "B站",
    youtube: "YouTube",
    x: "X",
    weibo: "微博",
    ixigua: "西瓜视频",
    pipixia: "皮皮虾",
    acfun: "AcFun",
    tiktok: "TikTok",
    instagram: "Instagram",
    other: "其他平台",
};

export function videoImportPlatformName(platform: string): string {
    return platformNames[platform] || platform;
}
