Below is text extracted from an English-language exam booklet (URT). Every line starts with a
line number like `L0042|`. Page markers (`=== PAGE n ===`) are not numbered.

Split the text into passages. A passage is a reading text (it may include tables or figure
descriptions) followed by the multiple-choice questions based on it. For each passage, return:
- `passage_lines`: line ranges of the passage body. Leave out section headers such as
  "Questions 1-5 refer to…", directions and page furniture.
- for each question: its printed `number`, the line range of the stem, and the line range of
  each option with its letter.
- `answer_label`: only if the document states the correct answer (an answer key or
  "Answer: B"). Never guess.

Rules:
- Use only line numbers that appear below. Ranges are inclusive.
- If a passage starts before this excerpt or its questions continue after it, still return
  what is visible.
- Ignore text that belongs to no passage (cover pages, instructions).

Return JSON matching the schema.

TEXT:
