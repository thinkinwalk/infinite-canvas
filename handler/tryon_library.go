package handler

import "net/http"

type tryonModel struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Group  string `json:"group"`
	Gender string `json:"gender"`
	URL    string `json:"url"`
	Thumb  string `json:"thumb"`
	Child  bool   `json:"child,omitempty"`
}

type tryonScene struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Env   string `json:"env"`
	URL   string `json:"url"`
	Thumb string `json:"thumb"`
}

// Adult entries retain the reference catalog; child references ship with the app.
func tryonLibrary() ([]tryonModel, []tryonScene) {
	const base = "https://pub-d4d9c8471e8d4d94b159b20f7fbdb7d7.r2.dev/library"
	models := []tryonModel{
		{"star1", "苏晚棠", "cn", "f", base + "/models/star1.png", base + "/models/star1_t.webp", false},
		{"f1", "林晚晴", "cn", "f", base + "/models/f1.png", base + "/models/f1_t.webp", false},
		{"f2", "苏念", "cn", "f", base + "/models/f2.png", base + "/models/f2_t.webp", false},
		{"f3", "顾听澜", "cn", "f", base + "/models/f3.png", base + "/models/f3_t.webp", false},
		{"f4", "周禾", "cn", "f", base + "/models/f4.png", base + "/models/f4_t.webp", false},
		{"cn-f1", "苏沐", "cn", "f", base + "/models/cn-f1.png", base + "/models/cn-f1_t.webp", false},
		{"cn-f2", "林清霜", "cn", "f", base + "/models/cn-f2.png", base + "/models/cn-f2_t.webp", false},
		{"cn-f3", "顾盼", "cn", "f", base + "/models/cn-f3.png", base + "/models/cn-f3_t.webp", false},
		{"ea-f5", "沈知意", "cn", "f", base + "/models/ea-f5.png", base + "/models/ea-f5_t.webp", false},
		{"ea-f6", "唐糖", "cn", "f", base + "/models/ea-f6.png", base + "/models/ea-f6_t.webp", false},
		{"ea-f7", "小满", "cn", "f", base + "/models/ea-f7.png", base + "/models/ea-f7_t.webp", false},
		{"m1", "陈屿", "cn", "m", base + "/models/m1.png", base + "/models/m1_t.webp", false},
		{"m2", "许之衡", "cn", "m", base + "/models/m2.png", base + "/models/m2_t.webp", false},
		{"m3", "吴桉", "cn", "m", base + "/models/m3.png", base + "/models/m3_t.webp", false},
		{"m4", "梁朝", "cn", "m", base + "/models/m4.png", base + "/models/m4_t.webp", false},
		{"cn-m1", "沈砚", "cn", "m", base + "/models/cn-m1.png", base + "/models/cn-m1_t.webp", false},
		{"cn-m2", "程屹", "cn", "m", base + "/models/cn-m2.png", base + "/models/cn-m2_t.webp", false},
		{"cn-m3", "陆鸣", "cn", "m", base + "/models/cn-m3.png", base + "/models/cn-m3_t.webp", false},
		{"ea-m5", "韩劲", "cn", "m", base + "/models/ea-m5.png", base + "/models/ea-m5_t.webp", false},
		{"jp-f1", "佐藤美咲", "jp", "f", base + "/models/jp-f1.png", base + "/models/jp-f1_t.webp", false},
		{"jp-f2", "铃木遥", "jp", "f", base + "/models/jp-f2.png", base + "/models/jp-f2_t.webp", false},
		{"jp-f3", "高桥结衣", "jp", "f", base + "/models/jp-f3.png", base + "/models/jp-f3_t.webp", false},
		{"jp-f4", "田中花音", "jp", "f", base + "/models/jp-f4.png", base + "/models/jp-f4_t.webp", false},
		{"jp-m1", "山田凉介", "jp", "m", base + "/models/jp-m1.png", base + "/models/jp-m1_t.webp", false},
		{"jp-m2", "伊藤大和", "jp", "m", base + "/models/jp-m2.png", base + "/models/jp-m2_t.webp", false},
		{"jp-m3", "渡边翔太", "jp", "m", base + "/models/jp-m3.png", base + "/models/jp-m3_t.webp", false},
		{"kr-f1", "金敏书", "kr", "f", base + "/models/kr-f1.png", base + "/models/kr-f1_t.webp", false},
		{"kr-f2", "朴秀妍", "kr", "f", base + "/models/kr-f2.png", base + "/models/kr-f2_t.webp", false},
		{"kr-f3", "李知恩", "kr", "f", base + "/models/kr-f3.png", base + "/models/kr-f3_t.webp", false},
		{"kr-f4", "崔宥真", "kr", "f", base + "/models/kr-f4.png", base + "/models/kr-f4_t.webp", false},
		{"kr-m1", "姜敏赫", "kr", "m", base + "/models/kr-m1.png", base + "/models/kr-m1_t.webp", false},
		{"kr-m2", "韩道允", "kr", "m", base + "/models/kr-m2.png", base + "/models/kr-m2_t.webp", false},
		{"kr-m3", "林宰范", "kr", "m", base + "/models/kr-m3.png", base + "/models/kr-m3_t.webp", false},
		{"se-f1", "Maya", "intl", "f", base + "/models/se-f1.png", base + "/models/se-f1_t.webp", false},
		{"se-m1", "Arto", "intl", "m", base + "/models/se-m1.png", base + "/models/se-m1_t.webp", false},
		{"sa-f1", "Priya", "intl", "f", base + "/models/sa-f1.png", base + "/models/sa-f1_t.webp", false},
		{"sa-f2", "Anaya", "intl", "f", base + "/models/sa-f2.png", base + "/models/sa-f2_t.webp", false},
		{"sa-m1", "Rohan", "intl", "m", base + "/models/sa-m1.png", base + "/models/sa-m1_t.webp", false},
		{"eu-f1", "Emma", "intl", "f", base + "/models/eu-f1.png", base + "/models/eu-f1_t.webp", false},
		{"eu-f2", "Sofia", "intl", "f", base + "/models/eu-f2.png", base + "/models/eu-f2_t.webp", false},
		{"eu-f3", "Claire", "intl", "f", base + "/models/eu-f3.png", base + "/models/eu-f3_t.webp", false},
		{"eu-m1", "Liam", "intl", "m", base + "/models/eu-m1.png", base + "/models/eu-m1_t.webp", false},
		{"af-f1", "Amara", "intl", "f", base + "/models/af-f1.png", base + "/models/af-f1_t.webp", false},
		{"af-f2", "Zola", "intl", "f", base + "/models/af-f2.png", base + "/models/af-f2_t.webp", false},
		{"af-m1", "Kwame", "intl", "m", base + "/models/af-m1.png", base + "/models/af-m1_t.webp", false},
		{"la-f1", "Lucia", "intl", "f", base + "/models/la-f1.png", base + "/models/la-f1_t.webp", false},
		{"la-m1", "Mateo", "intl", "m", base + "/models/la-m1.png", base + "/models/la-m1_t.webp", false},
		{"me-f1", "Layla", "intl", "f", base + "/models/me-f1.png", base + "/models/me-f1_t.webp", false},
		{"me-m1", "Omar", "intl", "m", base + "/models/me-m1.png", base + "/models/me-m1_t.webp", false},
		{"mix-f1", "Nina", "intl", "f", base + "/models/mix-f1.png", base + "/models/mix-f1_t.webp", false},
		{"mix-m1", "Kai", "intl", "m", base + "/models/mix-m1.png", base + "/models/mix-m1_t.webp", false},
	}
	models = append(models, tryonChildModels...)
	scenes := []tryonScene{
		{"s1", "室内灰调商务", "室内", base + "/scenes/s1.png", base + "/scenes/s1_t.webp"},
		{"s2", "花园清新", "户外", base + "/scenes/s2.png", base + "/scenes/s2_t.webp"},
		{"s3", "夜市潮流", "街景", base + "/scenes/s3.png", base + "/scenes/s3_t.webp"},
		{"s4", "咖啡外摆", "户外", base + "/scenes/s4.png", base + "/scenes/s4_t.webp"},
		{"s5", "黑白极简", "影棚", base + "/scenes/s5.png", base + "/scenes/s5_t.webp"},
		{"s6", "泳池度假", "度假", base + "/scenes/s6.png", base + "/scenes/s6_t.webp"},
		{"s7", "城市街拍", "街景", base + "/scenes/s7.png", base + "/scenes/s7_t.webp"},
		{"s8", "居家温馨", "室内", base + "/scenes/s8.png", base + "/scenes/s8_t.webp"},
		{"s9", "ins风卧室", "室内", base + "/scenes/s9.png", base + "/scenes/s9_t.webp"},
		{"s10", "复古胶片街景", "街景", base + "/scenes/s10.png", base + "/scenes/s10_t.webp"},
		{"s11b", "海边日落", "度假", base + "/scenes/s11b.png", base + "/scenes/s11b_t.webp"},
		{"s12", "雪景街拍", "街景", base + "/scenes/s12.png", base + "/scenes/s12_t.webp"},
		{"s13", "商场橱窗", "室内", base + "/scenes/s13.png", base + "/scenes/s13_t.webp"},
		{"s14", "屋顶天台", "户外", base + "/scenes/s14.png", base + "/scenes/s14_t.webp"},
	}
	return models, scenes
}

func TryonLibrary(w http.ResponseWriter, r *http.Request) {
	models, scenes := tryonLibrary()
	OK(w, map[string]any{"models": models, "scenes": scenes, "poses": tryonPresetPoses})
}
