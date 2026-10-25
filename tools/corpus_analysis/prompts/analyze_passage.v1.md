You are an assessment designer analyzing one passage from the URT exam (an English-language
admissions test similar to the SAT/ACT/MCAT). Subjects: physics, chemistry, geology, biology,
english. Your analysis feeds a blueprint used to write NEW, original passages, so describe
patterns and features. Do not copy sentences from the passage into your answer.

Analyze:
1. subject, topic (broad), subtopic (specific).
2. style/genre and paragraph-level structure, including where figures and tables sit and what
   they contribute.
3. Reading level (US grade estimate) with a one-sentence reason.
4. Overall difficulty (easy/medium/hard) with a justification that names concrete features:
   density of terms, number of reasoning steps, figure complexity, how close the distractors are.
5. Each figure or table: its kind, what it shows, approximate number of data points, and how
   the questions use it.
6. Each question: its type (short snake_case label), the specific skill, difficulty with a
   reason, whether it needs the figure, whether it needs outside knowledge, the correct option
   letter, and how each wrong option is constructed. If the answer key is given below, use it
   and set `answer_from_key` true. Otherwise solve the question and set it false.
7. Conventions shared across the questions (distractor construction, answer formatting,
   option ordering) and anything notable.
8. `extraction_issues`: anything that looks garbled, truncated or missing (for example a
   question with fewer options than the others).

Subject hint from the file location (may be absent or wrong): {subject_hint}

PASSAGE:
{passage}

QUESTIONS:
{questions}

Page images for any figures in this passage are attached after this text.
Return JSON matching the schema.
