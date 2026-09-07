const GROUP_SIZES_BY_QUESTION_COUNT = new Map([
  [17, [3, 3, 3, 3, 3, 2]],
]);

const DEFAULT_GROUP_SIZE = 4;

export function getQuestionGroupRanges(questions = []) {
  const questionCount = questions.length;
  const groupSizes = GROUP_SIZES_BY_QUESTION_COUNT.get(questionCount);

  if (groupSizes) {
    let start = 0;
    return groupSizes.map(size => {
      const range = { start, end: start + size };
      start = range.end;
      return range;
    });
  }

  return Array.from(
    { length: Math.ceil(questionCount / DEFAULT_GROUP_SIZE) },
    (_, index) => ({
      start: index * DEFAULT_GROUP_SIZE,
      end: Math.min((index + 1) * DEFAULT_GROUP_SIZE, questionCount),
    }),
  );
}

export function getQuestionGroupLabel(questions = [], index) {
  const range = getQuestionGroupRanges(questions)[index];
  if (!range) return `묶음 ${index + 1}`;

  const first = questions[range.start]?.number ?? range.start + 1;
  const last = questions[range.end - 1]?.number ?? range.end;
  return `${first}-${last}번`;
}
