import unittest

from voice_reference_text import extract_burned_subtitles, parse_srt, text_subtitle_stream


def line(text, x, y, width=360, height=36):
    return {
        "rec_texts": [text],
        "rec_polys": [[
            [x, y], [x + width, y], [x + width, y + height], [x, y + height],
        ]],
    }


class VoiceReferenceTextTests(unittest.TestCase):
    def test_prefers_default_text_track_and_skips_bitmap_subtitles(self):
        streams = [
            {"index": 2, "codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle", "disposition": {"default": 1}},
            {"index": 3, "codec_type": "subtitle", "codec_name": "subrip", "disposition": {"default": 0}},
            {"index": 4, "codec_type": "subtitle", "codec_name": "mov_text", "disposition": {"default": 1}},
        ]
        self.assertEqual(text_subtitle_stream(streams)["index"], 4)
        self.assertEqual(text_subtitle_stream(streams[:1]), None)

    def test_parses_srt_and_normalizes_traditional_chinese(self):
        value = "1\n00:00:00,000 --> 00:00:01,000\n這是字幕 <i>原文</i>\n"
        self.assertEqual(parse_srt(value), "这是字幕 原文")

    def test_extracts_repeated_lower_caption_lane_and_ignores_overlay_text(self):
        frames = [
            [line("固定台标", 10, 40), line("這次在機場", 260, 760)],
            [line("固定台标", 10, 40), line("這次在機場", 260, 760)],
            [line("固定台标", 10, 40), line("後面很狼狽", 260, 760)],
            [line("固定台标", 10, 40), line("後面很狼狽", 260, 760)],
        ]
        self.assertEqual(extract_burned_subtitles(frames, (1000, 1000)), "这次在机场\n后面很狼狈")

    def test_no_reliable_subtitle_lane_returns_empty_text(self):
        self.assertEqual(extract_burned_subtitles([[line("角落标签", 5, 120)]], (1000, 1000)), "")


if __name__ == "__main__":
    unittest.main()
