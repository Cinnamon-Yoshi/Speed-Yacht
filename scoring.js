// Pure scoring functions — no state, no side effects. The server is the
// only thing that ever computes a category's value; clients only ever
// send "I rolled this" (implicitly, via roll_dice) and "score me in this
// category" (a key name, not a value) — the actual number always comes
// from here, server-side, so a modified client can't just claim 300
// points.

const CATEGORIES = [
  'ones', 'twos', 'threes', 'fours', 'fives', 'sixes',
  'threeKind', 'fourKind', 'fullHouse', 'smStraight', 'lgStraight',
  'chance', 'yahtzee'
];

function diceCounts(dice) {
  const counts = {};
  for (const v of dice) counts[v] = (counts[v] || 0) + 1;
  return counts;
}

function sum(dice) {
  return dice.reduce((a, b) => a + b, 0);
}

function isYahtzeeRoll(dice) {
  return new Set(dice).size === 1;
}

function hasStraight(dice, length) {
  const unique = [...new Set(dice)].sort((a, b) => a - b);
  let run = 1;
  for (let i = 1; i < unique.length; i++) {
    run = (unique[i] === unique[i - 1] + 1) ? run + 1 : 1;
    if (run >= length) return true;
  }
  return length <= 1;
}

function scoreFor(key, dice, settings, existingScores) {
  const counts = diceCounts(dice);
  const countValues = Object.values(counts);
  const upperKeys = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];

  // Yahtzee "Joker Rule" — once a player's FIRST Yahtzee is already
  // banked, a SUBSEQUENT Yahtzee roll can be used as a joker: if the
  // upper-section slot matching the rolled face is still open, ONLY
  // that slot gets the boosted value (face×5 — which for a genuine
  // 5-of-a-kind equals the normal count×face value anyway, so this
  // doesn't actually change anything by itself). The real effect is
  // once that matching upper slot is ALREADY filled: Full House/Sm
  // Straight/Lg Straight become available at their full fixed values
  // (25/30/40) even though a 5-of-a-kind roll doesn't literally form
  // those patterns — this is what actually differs from naive scoring.
  if (existingScores && key !== 'yahtzee' && isYahtzeeRoll(dice) && existingScores['yahtzee'] === (settings.firstYahtzee || 50)) {
    const matchedFace = dice[0];
    const upperKeyForFace = upperKeys[matchedFace - 1];
    if (existingScores[upperKeyForFace] == null) {
      if (key === upperKeyForFace) return matchedFace * 5;
    } else {
      if (key === 'fullHouse') return 25;
      if (key === 'smStraight') return 30;
      if (key === 'lgStraight') return 40;
    }
  }

  switch (key) {
    case 'ones': return (counts[1] || 0) * 1;
    case 'twos': return (counts[2] || 0) * 2;
    case 'threes': return (counts[3] || 0) * 3;
    case 'fours': return (counts[4] || 0) * 4;
    case 'fives': return (counts[5] || 0) * 5;
    case 'sixes': return (counts[6] || 0) * 6;
    case 'threeKind': return countValues.some(c => c >= 3) ? sum(dice) : 0;
    case 'fourKind': return countValues.some(c => c >= 4) ? sum(dice) : 0;
    case 'fullHouse': {
      const sorted = countValues.slice().sort();
      const isProperFullHouse = sorted.length === 2 && sorted[0] === 2 && sorted[1] === 3;
      return isProperFullHouse ? 25 : 0;
    }
    case 'smStraight': return hasStraight(dice, 4) ? 30 : 0;
    case 'lgStraight': return hasStraight(dice, 5) ? 40 : 0;
    case 'chance': return sum(dice);
    case 'yahtzee': return isYahtzeeRoll(dice) ? (settings.firstYahtzee || 50) : 0;
    default: return 0;
  }
}

function upperSum(scores) {
  return ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes']
    .reduce((total, k) => total + (scores[k] || 0), 0);
}

function grandTotal(scores, yahtzeeBonusCount, settings) {
  const upper = upperSum(scores);
  const upperBonus = upper >= 63 ? (settings.upperBonus || 35) : 0;
  const lower = CATEGORIES.filter(k => !['ones','twos','threes','fours','fives','sixes'].includes(k))
    .reduce((total, k) => total + (scores[k] || 0), 0);
  const yahtzeeBonusTotal = yahtzeeBonusCount * (settings.yahtzeeBonus || 100);
  return upper + upperBonus + lower + yahtzeeBonusTotal;
}

module.exports = { CATEGORIES, scoreFor, isYahtzeeRoll, upperSum, grandTotal };
