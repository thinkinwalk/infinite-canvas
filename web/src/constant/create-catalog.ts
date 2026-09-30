import { Blend, Clapperboard, Copy, Eraser, FileText, ImagePlus, Layers3, Maximize2, Palette, Scissors, ShieldCheck, Shirt, Stamp, Type, Wand2, Wind, type LucideIcon } from "lucide-react";

export type CatalogItem = {
    id: string;
    title: string;
    description: string;
    category: string;
    medium: "image" | "video" | "canvas";
    source: "official" | "creator";
    price: string;
    href: string;
    icon: LucideIcon;
    cover?: string;
};

export const baseItems: CatalogItem[] = [
    {
        id: "free-image",
        title: "生图工作台",
        description: "输入创意、添加参考图，自由生成商品图和视觉素材。",
        category: "自由创作",
        medium: "image",
        source: "official",
        price: "按所选模型报价",
        href: "/image",
        icon: ImagePlus,
    },
    {
        id: "free-video",
        title: "视频创作台",
        description: "用文字或参考图制作短视频，调整时长和画面规格。",
        category: "自由创作",
        medium: "video",
        source: "official",
        price: "按所选模型报价",
        href: "/video",
        icon: Clapperboard,
    },
    {
        id: "canvas",
        title: "专业画布",
        description: "编排图片、视频和节点流程，制作可发布的创作画布。",
        category: "进阶创作",
        medium: "canvas",
        source: "official",
        price: "生成时按模型报价",
        href: "/canvas",
        icon: Maximize2,
    },
];

export const productSetItem: CatalogItem = {
    id: "official-product-grid",
    title: "AI 商品套图",
    description: "上传商品图，生成主图、卖点图和场景图组成的电商套图。",
    category: "电商制图",
    medium: "image",
    source: "official",
    price: "方案与成图分别报价",
    href: "/cases/product-listing-set",
    icon: Layers3,
    cover: "/examples/product-set/02-hero.png",
};

const officialCase = (id: string, title: string, category: string, icon: LucideIcon): CatalogItem => ({
    id,
    title,
    description: title,
    category,
    medium: category === "视频创作" ? "video" : "image",
    source: "official",
    price: "按后台模型算力点报价",
    href: `/cases?case=${id}`,
    icon,
});

export const officialCaseItems: CatalogItem[] = [
    { ...productSetItem, category: "常用工具" },
    { ...officialCase("official-image-variations", "图裂变", "常用工具", Copy), href: "/cases/image-variations" },
    officialCase("official-cutout", "AI 抠图", "图像处理", Scissors),
    officialCase("official-upscale", "AI 变清晰", "图像处理", Wand2),
    officialCase("official-inpaint", "局部改图", "图像处理", Palette),
    officialCase("official-fusion", "AI 融图", "图像处理", Blend),
    officialCase("official-dewatermark", "去水印", "图像处理", Eraser),
    officialCase("official-tryon", "服装上身", "服装电商", Shirt),
    officialCase("official-garment-extract", "服装提取", "服装电商", Shirt),
    officialCase("official-garment-3d", "3D 服装图", "服装电商", Shirt),
    officialCase("official-dewrinkle", "服装去皱", "服装电商", Wind),
    officialCase("official-title-gen", "标题生成", "营销工具", Type),
    officialCase("official-print-extract", "印花提取", "营销工具", Stamp),
    officialCase("official-ip-check", "侵权检测", "营销工具", ShieldCheck),
    officialCase("official-print-file", "印刷图", "营销工具", FileText),
];

export const createToolGroups = [
    { label: "常用工具", items: officialCaseItems.filter((item) => item.category === "常用工具") },
    { label: "图像处理", items: officialCaseItems.filter((item) => item.category === "图像处理") },
    { label: "服装电商", items: officialCaseItems.filter((item) => item.category === "服装电商") },
    { label: "营销工具", items: officialCaseItems.filter((item) => item.category === "营销工具") },
];
