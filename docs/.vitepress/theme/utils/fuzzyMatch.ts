import DiffMatchPatch from 'diff-match-patch';

interface MatchResult {
  start: number;
  end: number;
  similarity: number;
}

export function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + 1
        );
      }
    }
  }

  return dp[m][n];
}

export function calculateSimilarity(s1: string, s2: string): number {
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1;
  const distance = levenshteinDistance(s1, s2);
  return 1 - distance / maxLen;
}

export function findBestMatch(
  text: string,
  quote: string,
  threshold = 0.8
): MatchResult | null {
  if (!quote || quote.length === 0) return null;

  const quoteLen = quote.length;
  const textLen = text.length;

  if (quoteLen > textLen) return null;

  let bestMatch: MatchResult | null = null;
  let bestSimilarity = 0;

  const windowSize = Math.min(quoteLen + 50, textLen);

  for (let i = 0; i <= textLen - quoteLen; i++) {
    const window = text.substring(i, i + windowSize);
    const similarity = calculateSimilarity(quote, window);

    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = {
        start: i,
        end: i + quoteLen,
        similarity
      };
    }
  }

  if (bestMatch && bestMatch.similarity >= threshold) {
    return bestMatch;
  }

  return null;
}

export function findBestMatchWithDMP(
  text: string,
  quote: string,
  threshold = 0.8
): MatchResult | null {
  const dmp = new DiffMatchPatch();
  const matches = dmp.match_main(text, quote, 0);

  if (matches === -1) {
    return findBestMatch(text, quote, threshold);
  }

  return {
    start: matches,
    end: matches + quote.length,
    similarity: 1
  };
}
