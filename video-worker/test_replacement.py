import unittest

from replacement import fit_frame_count, plan_segments, validate_masked_generation, validate_timeline


class ReplacementTimelineTests(unittest.TestCase):
    def test_wan_short_video_keeps_one_part_despite_detected_cuts(self):
        cuts = [0.6, 2.866667, 3.233333, 4.933333, 6.6, 8.166667, 9.633333, 10.933333, 12.766667]
        parts = plan_segments(15, 15, cuts, preserve_scenes=False)
        self.assertEqual(len(parts), 1)
        self.assertEqual((parts[0]["inputStart"], parts[0]["inputEnd"]), (0, 15))
        self.assertEqual(len(plan_segments(15, 15, cuts)), 10)

    def test_packing_keeps_long_video_coverage_and_input_limits(self):
        for cuts in ([1, 2, 9, 16, 17, 30, 31], [1, 40, 41], []):
            parts = plan_segments(180, 15, cuts, preserve_scenes=False)
            self.assertEqual(parts[0]["start"], 0)
            self.assertEqual(parts[-1]["end"], 180)
            for part in parts:
                self.assertLessEqual(part["inputEnd"] - part["inputStart"], 15)
            for left, right in zip(parts, parts[1:]):
                self.assertEqual(left["end"], right["start"])

    def test_three_minutes_keeps_every_interval_and_overlap_in_api_limit(self):
        parts = plan_segments(180, 10)
        self.assertEqual(parts[0]["start"], 0)
        self.assertEqual(parts[-1]["end"], 180)
        for part in parts:
            self.assertGreater(part["end"], part["start"])
            self.assertLessEqual(part["inputEnd"] - part["inputStart"], 10)
        for left, right in zip(parts, parts[1:]):
            self.assertEqual(left["end"], right["start"])
            self.assertAlmostEqual(left["inputEnd"] - right["inputStart"], 0.5)

    def test_hard_cuts_and_short_last_shot_are_not_discarded(self):
        parts = plan_segments(31.125, 15, [0.125, 11, 31])
        for cut in (0.125, 11, 31):
            self.assertIn(cut, [p["end"] for p in parts])
            for p in parts:
                self.assertFalse(p["inputStart"] < cut < p["inputEnd"])
        self.assertEqual(parts[-1]["end"] - parts[-1]["start"], 0.125)

    def test_bad_duration_never_enters_split_loop(self):
        for seconds in (0, 0.5, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                plan_segments(180, seconds)

    def test_shortened_generation_and_changed_aspect_are_rejected(self):
        source = {"duration": 10, "fps": 30, "size": (1080, 1920)}
        for changed in ({"duration": 5}, {"size": (1920, 1080)}, {"fps": 0}):
            with self.assertRaises(ValueError):
                validate_timeline(source, {**source, **changed})
        validate_timeline(source, {**source, "fps": 25, "size": (720, 1280), "duration": 10.02})

    def test_masked_generation_tolerates_model_size_and_tail_padding_only(self):
        source = {"duration": 5.0, "fps": 30, "size": (480, 848)}
        validate_masked_generation(source, {"duration": 4.966667, "fps": 30, "size": (464, 832)})
        validate_masked_generation(source, {"duration": 5.0625, "fps": 16, "size": (480, 832)})
        for changed in ({"size": (848, 480)}, {"size": (480, 640)}, {"duration": 4.5}, {"duration": 5.5}, {"fps": 0}):
            with self.assertRaises(ValueError):
                validate_masked_generation(source, {"duration": 5.0, "fps": 30, "size": (464, 832), **changed})

    def test_frame_count_drops_padding_or_repeats_last_frame_within_limit(self):
        self.assertEqual(fit_frame_count(range(152), 150, 7), list(range(150)))
        self.assertEqual(fit_frame_count(range(149), 150, 7), [*range(149), 148])
        for frames in (range(140), []):
            with self.assertRaises(ValueError):
                fit_frame_count(frames, 150, 7)


if __name__ == "__main__":
    unittest.main()
