"""Synthetic exam-like text (invented for tests; not taken from any real exam)."""

PASSAGE_1 = [
    "Questions 1-3 refer to the following passage.",
    "A student investigated how the temperature of water affects the rate at which sugar",
    "dissolves. She placed equal masses of sugar into beakers held at four temperatures and",
    "recorded the time needed for the crystals to disappear completely. Each trial was repeated",
    "three times and the mean time was calculated. The results show that dissolving time fell",
    "steadily as temperature rose, although the decrease became smaller at higher temperatures.",
    "Temperature (C) | Mean time (s)",
    "20 | 120",
    "40 | 70",
]
QUESTIONS_1 = [
    "1. Which variable did the student change on purpose?",
    "(A) Mass of sugar",
    "(B) Water temperature",
    "(C) Dissolving time",
    "(D) Number of trials",
    "2. According to the table, the mean time at 40 C was",
    "(A) 20 s (B) 40 s (C) 70 s (D) 120 s",
    "3. Which conclusion is best supported by",
    "the results?",
    "A. Temperature has no effect.",
    "B. Higher temperature shortens dissolving time.",
    "C. Sugar mass controls the rate.",
    "D. Stirring was the main factor.",
]
PASSAGE_2 = [
    "Passage II",
    "Glaciers move because ice deforms under its own weight and slides over the bedrock beneath",
    "it. Meltwater at the base can reduce friction and allow the glacier to advance more quickly",
    "during warm months. Geologists measure this motion with stakes driven into the surface,",
    "whose positions are recorded with satellite receivers over a period of several years.",
    "Comparing summer and winter records shows how strongly the base responds to seasonal melting.",
]
QUESTIONS_2 = [
    "4. The passage suggests that meltwater",
    "(A) stops glacier motion",
    "(B) increases basal friction",
    "(C) can speed up a glacier",
    "(D) forms only in winter",
    "5. Stakes are used to",
    "(A) melt the ice",
    "(B) measure motion",
    "(C) anchor the glacier",
    "(D) record temperature",
]
ANSWER_KEY = ["Answer Key", "1. B  2. C  3. B", "4. C", "5. B"]

GOOD_DOCUMENT_PAGES = [PASSAGE_1 + QUESTIONS_1, PASSAGE_2 + QUESTIONS_2 + ANSWER_KEY]
