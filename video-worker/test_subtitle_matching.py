import unittest

from subtitle_matching import matched_ocr_indices, overlaps_caption_line


class SubtitleMatchingTests(unittest.TestCase):
    def test_partial_unmatched_caption_is_reported_but_separate_sign_is_not(self):
        lines = [(100, 900, 600, 960)]
        self.assertTrue(overlaps_caption_line([(200, 910), (500, 950)], lines))
        self.assertFalse(overlaps_caption_line([(100, 300), (600, 400)], lines))

    def test_real_asr_misheard_suffix_keeps_ocr_caption_but_not_shop_sign(self):
        speech = [{"start": 10.5, "end": 12.08, "text": "蓝底白字刻样旺"}]
        self.assertEqual(matched_ocr_indices(["李与白", "包子铺", "蓝底白字客源"], speech, 11.5), [2])

    def test_traditional_speech_matches_simplified_caption(self):
        speech = [{"start": 0.72, "end": 3.1, "text": "最旺人的六種饅頭配色請收藏"}]
        self.assertEqual(matched_ocr_indices(["门头配色请收藏"], speech, 1), [0])

    def test_short_overlap_duplicate_and_out_of_time_do_not_match(self):
        speech = [{"start": 1, "end": 2, "text": "蓝底白字刻样旺"}]
        for texts, time in [(["白字广告"], 1.5), (["蓝底白字", "蓝底白字"], 1.5), (["蓝底白字"], 2.5), (["白"], 1.5)]:
            self.assertEqual(matched_ocr_indices(texts, speech, time), [])


if __name__ == "__main__":
    unittest.main()
