package service

import (
	"math"
	"testing"
)

func TestNormalizeAnalysisWindowsClampsAndMerges(t *testing.T) {
	windows := NormalizeAnalysisWindows(10, []AnalysisWindow{
		{Start: -2, End: 2},
		{Start: 1.5, End: 4},
		{Start: 8, End: 20},
		{Start: math.NaN(), End: 3},
	})
	if len(windows) != 2 || windows[0] != (AnalysisWindow{Start: 0, End: 4}) || windows[1].End != 10 {
		t.Fatalf("windows = %#v", windows)
	}
}

func TestAnalysisDetailTimesAvoidsExistingSamples(t *testing.T) {
	got := AnalysisDetailTimesAvoiding(10, 4, []AnalysisWindow{{Start: 4, End: 6}}, []float64{5}, 0.1)
	if len(got) != 4 {
		t.Fatalf("got %v", got)
	}
	for _, time := range got {
		if time < 4 || time > 6 || math.Abs(time-5) < 0.1 {
			t.Fatalf("time %v is outside the review window or duplicates an existing sample", time)
		}
	}
}
