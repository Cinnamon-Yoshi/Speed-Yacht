const { CATEGORIES, scoreFor, isYahtzeeRoll, upperSum, grandTotal } = require('./scoring');

const settings = { firstYahtzee: 50, upperBonus: 35, yahtzeeBonus: 100 };
let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// Upper section
check('ones with three 1s', scoreFor('ones', [1,1,1,4,5], settings), 3);
check('sixes with two 6s', scoreFor('sixes', [6,6,2,3,4], settings), 12);
check('twos with no 2s', scoreFor('twos', [1,3,4,5,6], settings), 0);

// Three/four of a kind
check('threeKind qualifies (sum of all dice)', scoreFor('threeKind', [3,3,3,5,6], settings), 20);
check('threeKind does not qualify', scoreFor('threeKind', [1,2,3,4,5], settings), 0);
check('fourKind qualifies', scoreFor('fourKind', [4,4,4,4,2], settings), 18);
check('fourKind does not qualify (only 3oak)', scoreFor('fourKind', [4,4,4,2,2], settings), 0);
check('fourKind qualifies via 5oak too', scoreFor('fourKind', [5,5,5,5,5], settings), 25);

// Full house
check('proper full house (3+2)', scoreFor('fullHouse', [2,2,2,6,6], settings), 25);
check('not a full house (3+1+1)', scoreFor('fullHouse', [2,2,2,6,4], settings), 0);
check('not a full house (2+2+1)', scoreFor('fullHouse', [2,2,6,6,4], settings), 0);
check('5oak alone (no joker context) does NOT count as full house', scoreFor('fullHouse', [3,3,3,3,3], settings), 0);

// Straights
check('small straight 1-2-3-4', scoreFor('smStraight', [1,2,3,4,6], settings), 30);
check('small straight embedded 2-3-4-5 in 5 dice', scoreFor('smStraight', [1,2,3,4,5], settings), 30); // also has 4-straight, should still score
check('no small straight', scoreFor('smStraight', [1,1,3,5,6], settings), 0);
check('large straight 1-2-3-4-5', scoreFor('lgStraight', [1,2,3,4,5], settings), 40);
check('large straight 2-3-4-5-6', scoreFor('lgStraight', [2,3,4,5,6], settings), 40);
check('no large straight (has gap)', scoreFor('lgStraight', [1,2,3,4,6], settings), 0);
check('no large straight (has dupe)', scoreFor('lgStraight', [1,2,2,4,5], settings), 0);

// Chance
check('chance is just the sum', scoreFor('chance', [1,2,3,4,5], settings), 15);

// Yahtzee
check('yahtzee — all same', scoreFor('yahtzee', [4,4,4,4,4], settings), 50);
check('yahtzee — not all same', scoreFor('yahtzee', [4,4,4,4,5], settings), 0);
check('isYahtzeeRoll true', isYahtzeeRoll([2,2,2,2,2]), true);
check('isYahtzeeRoll false', isYahtzeeRoll([2,2,2,2,3]), false);

// Upper bonus threshold
check('upperSum computed correctly', upperSum({ones:3, twos:6, threes:9, fours:12, fives:15, sixes:18}), 63);

// Grand total: upper (63, gets bonus) + lower categories + yahtzee bonus
const fullScoresAtThreshold = {
  ones:3, twos:6, threes:9, fours:12, fives:15, sixes:18, // = 63, triggers bonus
  threeKind:20, fourKind:18, fullHouse:25, smStraight:30, lgStraight:40, chance:24, yahtzee:50
};
const expectedLower = 20+18+25+30+40+24+50; // 207
const expectedTotal = 63 + 35 /*bonus*/ + expectedLower + 0 /*no extra yahtzee bonus*/;
check('grandTotal with upper bonus, no yahtzee bonus', grandTotal(fullScoresAtThreshold, 0, settings), expectedTotal);

const withYahtzeeBonus = grandTotal(fullScoresAtThreshold, 2, settings); // 2 extra yahtzees
check('grandTotal with 2x yahtzee bonus adds 200', withYahtzeeBonus, expectedTotal + 200);

const belowThreshold = { ones:1, twos:2, threes:3, fours:4, fives:5, sixes:6 }; // upper=21, no bonus
check('grandTotal below 63 threshold gets no bonus', grandTotal(belowThreshold, 0, settings), 21);

// ── Yahtzee Joker Rule ──────────────────────────────────────────────
// Official rule: once a player's FIRST Yahtzee is banked, a SUBSEQUENT
// Yahtzee roll can be used as a joker. This only actually changes
// anything once the matching upper-section slot is already filled —
// at that point Full House/Sm Straight/Lg Straight become scoreable at
// their full fixed values despite not literally being those patterns.
const rollSecondYahtzee = [4,4,4,4,4];

// No joker context at all (existingScores omitted) — plain scoring,
// no special treatment. This is also what a brand new player's very
// FIRST Yahtzee roll looks like, before anything is banked.
check('fullHouse with no existingScores context: no joker', scoreFor('fullHouse', rollSecondYahtzee, settings), 0);
check('smStraight with no existingScores context: no joker', scoreFor('smStraight', rollSecondYahtzee, settings), 0);

// First Yahtzee not yet banked (still 0/undefined) — a raw 5oak still
// isn't a joker yet, even if this IS technically their first Yahtzee
// roll of the game.
check('fullHouse before first Yahtzee is banked: no joker', scoreFor('fullHouse', rollSecondYahtzee, settings, { yahtzee: 0 }), 0);

// First Yahtzee IS banked, matching upper slot (fours, since rolled
// all 4s) is STILL OPEN — only that exact upper slot gets boosted
// (face×5, which for a genuine 5oak equals normal count×face anyway).
// Full House should NOT be joker-scoreable yet — matching upper slot
// must be filled first.
const bankedFirstYahtzee = { yahtzee: settings.firstYahtzee };
check('matching upper slot (fours) open: fours gets the boosted value', scoreFor('fours', rollSecondYahtzee, settings, bankedFirstYahtzee), 20);
check('matching upper slot open: fullHouse is NOT joker-scoreable yet', scoreFor('fullHouse', rollSecondYahtzee, settings, bankedFirstYahtzee), 0);
check('matching upper slot open: smStraight is NOT joker-scoreable yet', scoreFor('smStraight', rollSecondYahtzee, settings, bankedFirstYahtzee), 0);

// First Yahtzee banked AND the matching upper slot (fours) is ALREADY
// filled — NOW Full House/Sm Straight/Lg Straight unlock as jokers.
const upperSlotFilled = { yahtzee: settings.firstYahtzee, fours: 16 };
check('matching upper slot filled: fullHouse joker unlocks (25)', scoreFor('fullHouse', rollSecondYahtzee, settings, upperSlotFilled), 25);
check('matching upper slot filled: smStraight joker unlocks (30)', scoreFor('smStraight', rollSecondYahtzee, settings, upperSlotFilled), 30);
check('matching upper slot filled: lgStraight joker unlocks (40)', scoreFor('lgStraight', rollSecondYahtzee, settings, upperSlotFilled), 40);

// Joker rule should NEVER touch the 'yahtzee' category itself (that's
// always just the plain first/subsequent yahtzee check), and threeKind/
// fourKind/chance already correctly score a 5oak via their own normal
// pattern-matching (sum of all 5 dice qualifies for both), so the
// joker branch correctly doesn't need to special-case them either.
check('yahtzee category itself is never affected by the joker branch', scoreFor('yahtzee', rollSecondYahtzee, settings, upperSlotFilled), settings.firstYahtzee);
check('threeKind still scores normally (unaffected by joker branch)', scoreFor('threeKind', rollSecondYahtzee, settings, upperSlotFilled), 20);
check('chance still scores normally (unaffected by joker branch)', scoreFor('chance', rollSecondYahtzee, settings, upperSlotFilled), 20);

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
