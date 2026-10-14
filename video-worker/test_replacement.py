import unittest

from replacement import plan_segments, validate_timeline


class ReplacementTimelineTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
