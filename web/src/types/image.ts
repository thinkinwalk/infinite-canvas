export type ReferenceImage = {
    id: string;
    name: string;
    type: string;
    dataUrl: string;
    url?: string;
    storageKey?: string;
    videoFrame?: { ratio: "16:9" | "9:16"; x: number; y: number; sourceWidth: number; sourceHeight: number };
};
