import unittest

from corpus_analysis.schemas import ExtractedDocument, LineRange, LLMOption, LLMPassage, LLMQuestion, \
    LLMSegmentation, PageInfo
from corpus_analysis.segment import clean_lines, numbered_text, segment_document, split_options

from tests.fixtures import ANSWER_KEY, GOOD_DOCUMENT_PAGES, PASSAGE_1, QUESTIONS_1


def make_doc(pages: list[list[str]], figure_pages: set[int] = frozenset()) -> ExtractedDocument:
    return ExtractedDocument(sha256="f" * 64, source_name="sample.pdf", page_count=len(pages), pages=[
        PageInfo(index=i, text="\n".join(lines), method="text", char_count=len("".join(lines)), image_count=0,
                 vector_object_count=0, table_count=0, has_figure=i in figure_pages)
        for i, lines in enumerate(pages)
    ])


class SplitOptionsTest(unittest.TestCase):
    def test_inline_options(self):
        self.assertEqual(split_options("(A) 20 s (B) 40 s (C) 70 s (D) 120 s"),
                         [("A", "20 s"), ("B", "40 s"), ("C", "70 s"), ("D", "120 s")])

    def test_out_of_sequence_letter_is_not_a_new_option(self):
        self.assertEqual(split_options("A. Vitamin C. deficiency causes scurvy"),
                         [("A", "Vitamin C. deficiency causes scurvy")])


PROSE = ["In a certain experiment we measure the retarding force that a fluid exerts on an object",
         "moving through it, and we vary the cross-sectional area and the speed of the object while",
         "recording the force for each trial in a table so that the exponents can be found later on."]


class NumberingAndLabelTest(unittest.TestCase):
    def test_dash_numbered_questions(self):
        qs = ["1- Which pair of experiments determines n?", "A. 2 and 3.", "B. 3 and 4", "C. 4 and 6",
              "D. 5 and 6", "2- Which pair shows density does not matter?", "A. 1 and 2.", "B. 2 and 3.",
              "C. 1 and 6.", "D. 4 and 6."]
        result = segment_document(make_doc([["Passage I: Motion through liquids"] + PROSE + qs]),
                                  subject_hint="physics", threshold=0.7, llm_fn=None)
        self.assertEqual(len(result.segments), 1)
        s = result.segments[0]
        self.assertEqual([q.number for q in s.questions], [1, 2])
        self.assertEqual(s.questions[0].stem, "Which pair of experiments determines n?")
        self.assertEqual([len(q.options) for q in s.questions], [4, 4])

    def test_act_fghj_options_are_normalized(self):
        qs = ["1. Which is true?", "A. one", "B. two", "C. three", "D. four",
              "2. Which is false?", "F. five", "G. six", "H. seven", "J. eight"]
        result = segment_document(make_doc([PROSE + qs]), subject_hint="geology", threshold=0.7, llm_fn=None)
        self.assertEqual(len(result.segments), 1)
        q2 = result.segments[0].questions[1]
        self.assertEqual([o.label for o in q2.options], ["A", "B", "C", "D"])
        self.assertEqual(q2.options[2].text, "seven")
        self.assertNotIn("non-consecutive", " ".join(result.segments[0].warnings))

    def test_lowercase_paren_options(self):
        qs = ["1- Which is louder?", "a) The drum.", "b) The bell.", "c) Both.", "d) Neither."]
        s = segment_document(make_doc([PROSE + qs]), subject_hint=None, threshold=0.7, llm_fn=None).segments[0]
        self.assertEqual([o.label for o in s.questions[0].options], ["A", "B", "C", "D"])
        self.assertEqual(s.questions[0].options[1].text, "The bell.")

    def test_prose_starting_with_h_is_not_an_option(self):
        qs = ["1. Which bacterium?", "A. one", "B. two", "C. three", "D. four",
              "H. pylori may play a causal role in gastric ulcers."]
        s = segment_document(make_doc([PROSE + qs]), subject_hint=None, threshold=0.7, llm_fn=None).segments[0]
        self.assertEqual(len(s.questions[0].options), 4)


class RuleSegmentationTest(unittest.TestCase):
    def test_two_passages_with_answer_key(self):
        result = segment_document(make_doc(GOOD_DOCUMENT_PAGES, {0}), subject_hint="physics", threshold=0.7,
                                  llm_fn=None)
        self.assertEqual(result.method, "rule")
        self.assertEqual(len(result.segments), 2)
        s1, s2 = result.segments
        self.assertEqual([q.number for q in s1.questions], [1, 2, 3])
        self.assertEqual([q.number for q in s2.questions], [4, 5])
        self.assertEqual([q.answer for q in s1.questions + s2.questions], ["B", "C", "B", "C", "B"])
        self.assertTrue(all(len(q.options) == 4 for q in s1.questions + s2.questions))
        self.assertIn("dissolves", s1.passage_text)
        self.assertNotIn("Questions 1-3 refer", s1.passage_text)
        self.assertIn("Glaciers move", s2.passage_text)
        self.assertEqual(s1.questions[2].stem, "Which conclusion is best supported by the results?")
        self.assertEqual(s1.figure_pages, [0])
        self.assertGreaterEqual(result.file_confidence, 0.9)

    def test_new_passage_without_header_is_detected_by_prose_run(self):
        prose = ["Volcanic rocks form when magma cools at or near the surface of the Earth, and their",
                 "crystal size records how fast cooling happened. Basalt cools quickly and has fine grains,",
                 "while granite cools slowly deep underground and develops large, easily visible crystals."]
        qs = ["4. Fine grains indicate", "(A) slow cooling", "(B) fast cooling", "(C) no cooling",
              "(D) deep burial"]
        result = segment_document(make_doc([PASSAGE_1 + QUESTIONS_1 + prose + qs]), subject_hint=None,
                                  threshold=0.7, llm_fn=None)
        self.assertEqual(len(result.segments), 2)
        self.assertIn("Volcanic rocks", result.segments[1].passage_text)
        self.assertEqual(result.segments[0].questions[-1].options[-1].text, "Stirring was the main factor.")

    def test_inline_answer_lines(self):
        qs = ["1. Pick one", "(A) a", "(B) b", "(C) c", "(D) d", "Answer: C"]
        result = segment_document(make_doc([PASSAGE_1[1:] + qs]), subject_hint=None, threshold=0.7, llm_fn=None)
        self.assertEqual(result.segments[0].questions[0].answer, "C")

    def test_numbered_paragraph_without_options_is_not_a_question(self):
        text = ["1. In the first stage, water evaporates from the ocean surface and rises as vapour",
                "into the cooler air above, where it later condenses into clouds."] + PASSAGE_1[1:] + QUESTIONS_1
        result = segment_document(make_doc([text]), subject_hint=None, threshold=0.7, llm_fn=None)
        self.assertEqual([q.number for q in result.segments[0].questions], [1, 2, 3])
        self.assertIn("evaporates", result.segments[0].passage_text)

    def test_low_confidence_triggers_llm_fallback(self):
        broken = PASSAGE_1[1:] + ["1. Only two options", "(A) x", "(B) y"]
        doc = make_doc([broken])
        lines = clean_lines(doc)
        calls = []

        def fake_llm(numbered: str, ref: str) -> LLMSegmentation:
            calls.append(numbered)
            return LLMSegmentation(passages=[LLMPassage(
                passage_lines=[LineRange(start=1, end=8)],
                questions=[LLMQuestion(number=1, stem_lines=LineRange(start=9, end=9), answer_label="A",
                                       options=[LLMOption(label="A", lines=LineRange(start=10, end=10)),
                                                LLMOption(label="B", lines=LineRange(start=11, end=11))])])])

        result = segment_document(doc, subject_hint=None, threshold=0.7, llm_fn=fake_llm)
        self.assertEqual(len(calls), 1)
        self.assertIn("L0001| A student investigated", calls[0])
        self.assertEqual(result.method, "llm")
        q = result.segments[0].questions[0]
        self.assertEqual((q.stem, [o.text for o in q.options], q.answer), ("Only two options", ["x", "y"], "A"))
        self.assertEqual(len(lines), 11)

    def test_dry_run_fallback_keeps_rule_result(self):
        broken = PASSAGE_1[1:] + ["1. Only two options", "(A) x", "(B) y"]
        result = segment_document(make_doc([broken]), subject_hint=None, threshold=0.7, llm_fn=lambda t, r: None)
        self.assertEqual(result.method, "rule")
        self.assertLess(result.file_confidence, 0.7)


class CleaningTest(unittest.TestCase):
    def test_running_headers_and_page_numbers_removed(self):
        bodies = ["Rivers erode their banks.", "Stars fuse hydrogen.", "Cells divide by mitosis.",
                  "Acids donate protons."]
        pages = [["URT Practice Booklet 2024", body, f"Page {i + 1}"] for i, body in enumerate(bodies)]
        lines = clean_lines(make_doc(pages))
        self.assertEqual([ln.text for ln in lines], bodies)

    def test_numbered_text_has_page_markers(self):
        out = numbered_text(clean_lines(make_doc([["alpha"], ["beta"]])), 0, 1)
        self.assertEqual(out, "=== PAGE 1 ===\nL0001| alpha\n=== PAGE 2 ===\nL0002| beta")

    def test_answer_key_not_in_passage(self):
        result = segment_document(make_doc(GOOD_DOCUMENT_PAGES), subject_hint=None, threshold=0.7, llm_fn=None)
        self.assertNotIn(ANSWER_KEY[1], result.segments[-1].passage_text)


if __name__ == "__main__":
    unittest.main()
