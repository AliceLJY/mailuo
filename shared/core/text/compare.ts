export function normalizeComparableText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function editDistance(left: string, right: string): number {
  const leftCharacters = Array.from(left);
  const rightCharacters = Array.from(right);
  let previous = Array.from({ length: rightCharacters.length + 1 }, (_, index) => index);

  for (const [leftIndex, leftCharacter] of leftCharacters.entries()) {
    const current = [leftIndex + 1];

    for (const [rightIndex, rightCharacter] of rightCharacters.entries()) {
      current.push(Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + (leftCharacter === rightCharacter ? 0 : 1),
      ));
    }

    previous = current;
  }

  return previous[rightCharacters.length];
}

export function normalizedEditSimilarity(left: string, right: string): number {
  const leftLength = Array.from(left).length;
  const rightLength = Array.from(right).length;

  if (leftLength === 0 || rightLength === 0) {
    return 0;
  }

  return 1 - editDistance(left, right) / Math.max(leftLength, rightLength);
}

export function normalizeContactText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\s]+/gu, '');
}

export function tokenize(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .split(/[\p{P}\s]+/gu)
    .filter(Boolean);
}
