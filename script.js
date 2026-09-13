// ---------- state ----------
const state = {
  categories: [],   // full word database: [{ words: [w1,w2,w3,w4], theme }]
  columns: [[], [], [], []], // 4 stacks, bottom-first. index 0-3 = playable, 4-5 = locked
  targets: new Set(),        // red words not yet cleared
  selected: new Set(),       // currently selected words (max 4)
  flashCorrect: new Set(),   // words mid-way through the "correct" flash before they clear
  solved: [],                // [{ words, theme }] in the order they were solved
  turns: 0,
  over: false,               // true once the game has ended (win or dead end)
  overReason: null,          // "won" | "stuck"
};

const els = new Map(); // word -> tile DOM element, persists across renders so we can animate

const board = document.getElementById("board");
const turnCountEl = document.getElementById("turnCount");
const shortestTurnsEl = document.getElementById("shortestTurns");
const targetCountEl = document.getElementById("targetCount");
const messageEl = document.getElementById("message");
const submitBtn = document.getElementById("submitBtn");
const deselectBtn = document.getElementById("deselectBtn");
const newGameBtn = document.getElementById("newGameBtn");
const endOverlay = document.getElementById("endOverlay");
const overlayTitle = document.getElementById("overlayTitle");
const overlayMessage = document.getElementById("overlayMessage");
const playAgainBtn = document.getElementById("playAgainBtn");
const solveOneBtn = document.getElementById("solveOneBtn");
const solvedList = document.getElementById("solvedList");
const solvedEmpty = document.getElementById("solvedEmpty");

// ---------- setup ----------

async function init() {
  const res = await fetch("words.json");
  state.categories = await res.json();
  startNewGame();

  newGameBtn.addEventListener("click", startNewGame);
  playAgainBtn.addEventListener("click", () => {
    endOverlay.classList.add("hidden");
    startNewGame();
  });
  submitBtn.addEventListener("click", submitGuess);
  deselectBtn.addEventListener("click", () => {
    state.selected.clear();
    render();
  });
  solveOneBtn.addEventListener("click", solveOne);
}

// Finds a category that's entirely in the playable area right now and
// selects it for the player (a hint) — it doesn't submit the guess.
function solveOne() {
  if (state.over) return;
  const playable = new Set();
  state.columns.forEach((col) => col.slice(0, 4).forEach((w) => playable.add(w)));
  const cat = state.categories.find((c) => c.words.every((w) => playable.has(w)));
  if (cat) {
    state.selected = new Set(cat.words);
    messageEl.textContent = "";
    render();
  } else {
    messageEl.textContent = "No full category is available in the playable area right now.";
    messageEl.style.color = "var(--incorrect)";
  }
}

// Building a board at random doesn't guarantee the 4 red target words can
// actually all be cleared — some categories might end up permanently split
// between playable and locked in a way nothing ever unlocks. So we generate
// candidate boards and run a full search on each one, only keeping a board
// once we've proven there's a real sequence of guesses that clears every
// target, and recording the shortest such sequence to show the player.
const MAX_BOARD_ATTEMPTS = 300;

function startNewGame() {
  els.forEach((el) => el.remove());
  els.clear();

  let columns, targets, shortest;
  for (let attempt = 0; attempt < MAX_BOARD_ATTEMPTS; attempt++) {
    const words = pickBoardWords(24);
    const candidateColumns = distributeIntoColumns(words);
    const candidateTargets = pickTargets(candidateColumns);
    shortest = findShortestSolution(candidateColumns, candidateTargets, state.categories);
    if (shortest !== null) {
      columns = candidateColumns;
      targets = candidateTargets;
      break;
    }
  }
  // Fall back to the last attempt if we somehow never found a provably
  // solvable layout (only possible if the database is too sparse right now).
  if (!columns) {
    const words = pickBoardWords(24);
    columns = distributeIntoColumns(words);
    targets = pickTargets(columns);
    shortest = findShortestSolution(columns, targets, state.categories);
  }

  state.columns = columns;
  state.targets = targets;
  state.selected = new Set();
  state.flashCorrect = new Set();
  state.solved = [];
  state.turns = 0;
  state.over = false;
  state.overReason = null;

  shortestTurnsEl.textContent = shortest === null ? "unknown" : shortest;
  endOverlay.classList.add("hidden");
  messageEl.textContent = "";
  solvedList.innerHTML = "";
  solvedEmpty.hidden = false;
  render();
}

// ---------- solver: is this board winnable, and in how few turns? ----------

// A board state is fully described by the 4 column stacks (bottom-first).
// A category is playable from a state if all 4 of its words currently sit
// in the bottom 4 (unlocked) slots of their own column. Applying a category
// removes those words from their columns — mirroring removeWord() exactly,
// so anything above naturally shifts into the playable zone. We BFS over
// these states (turn by turn) so the first time we reach a state where none
// of the 4 target words remain, that's the shortest possible solution.
function columnsKey(columns) {
  return columns.map((c) => c.join(",")).join("|");
}

function playableCategoriesFor(columns, categories) {
  const positionOf = new Map();
  columns.forEach((col, c) => col.forEach((w, i) => positionOf.set(w, i)));
  return categories.filter(
    (cat) => cat.words.length === 4 && cat.words.every((w) => positionOf.get(w) < 4)
  );
}

function applyCategory(columns, cat) {
  const next = columns.map((col) => [...col]);
  cat.words.forEach((w) => {
    for (const col of next) {
      const idx = col.indexOf(w);
      if (idx !== -1) {
        col.splice(idx, 1);
        break;
      }
    }
  });
  return next;
}

function remainingTargets(columns, targets) {
  const present = new Set();
  columns.forEach((col) => col.forEach((w) => present.add(w)));
  for (const t of targets) {
    if (present.has(t)) return true;
  }
  return false;
}

function findShortestSolution(columns, targets, categories) {
  if (!remainingTargets(columns, targets)) return 0;

  const visited = new Set([columnsKey(columns)]);
  let frontier = [columns];
  const SAFETY_TURN_CAP = 40;

  for (let turns = 1; turns <= SAFETY_TURN_CAP && frontier.length; turns++) {
    const nextFrontier = [];
    for (const state of frontier) {
      for (const cat of playableCategoriesFor(state, categories)) {
        const next = applyCategory(state, cat);
        if (!remainingTargets(next, targets)) return turns;
        const key = columnsKey(next);
        if (!visited.has(key)) {
          visited.add(key);
          nextFrontier.push(next);
        }
      }
    }
    frontier = nextFrontier;
  }
  return null; // no sequence of legal guesses clears all 4 targets
}

// Greedily assemble 24 unique words, preferring categories that share
// words with what's already picked so the finished board has real overlap.
function pickBoardWords(target) {
  const shuffled = shuffle(state.categories.map((c) => c.words));
  const active = new Set();
  const used = new Set();

  function tryAdd(idx) {
    const words = shuffled[idx];
    const newOnes = words.filter((w) => !active.has(w));
    if (active.size + newOnes.length > target) return false;
    newOnes.forEach((w) => active.add(w));
    used.add(idx);
    return true;
  }

  tryAdd(0);
  let progress = true;
  while (active.size < target && progress) {
    progress = false;
    // pass 1: prefer a category that overlaps with what's already on the board
    for (let i = 0; i < shuffled.length; i++) {
      if (used.has(i)) continue;
      const overlap = shuffled[i].some((w) => active.has(w));
      if (overlap && tryAdd(i)) { progress = true; break; }
    }
    if (progress) continue;
    // pass 2: no overlapping category fits anymore, take anything that fits
    for (let i = 0; i < shuffled.length; i++) {
      if (used.has(i)) continue;
      if (tryAdd(i)) { progress = true; break; }
    }
  }

  // Fallback padding in the unlikely case we still fall short of 24.
  if (active.size < target) {
    const allWords = shuffle([...new Set(state.categories.flatMap((c) => c.words))]);
    for (const w of allWords) {
      if (active.size >= target) break;
      active.add(w);
    }
  }

  return shuffle([...active]).slice(0, target);
}

function distributeIntoColumns(words) {
  const columns = [[], [], [], []];
  words.forEach((w, i) => columns[i % 4].push(w));
  return columns;
}

function pickTargets(columns) {
  const playable = [];
  const locked = [];
  columns.forEach((col, c) => {
    col.forEach((w, i) => {
      (i < 4 ? playable : locked).push(w);
    });
  });
  const targets = new Set();
  shuffle(playable).slice(0, 2).forEach((w) => targets.add(w));
  shuffle(locked).slice(0, 2).forEach((w) => targets.add(w));
  return targets;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- interaction ----------

function findPosition(word) {
  for (let c = 0; c < 4; c++) {
    const i = state.columns[c].indexOf(word);
    if (i !== -1) return { c, i };
  }
  return null;
}

function onTileClick(word) {
  if (state.over) return;
  const pos = findPosition(word);
  if (!pos || pos.i >= 4) return; // locked tiles aren't clickable

  if (state.selected.has(word)) {
    state.selected.delete(word);
  } else if (state.selected.size < 4) {
    state.selected.add(word);
  }
  render();
}

// How many of the guessed words would complete SOME category (the best
// partial match), used to tell the player "you got N right" on a miss.
// A result of 4 can't happen here: that would already be a win above.
function bestOverlapCount(guessSet) {
  let best = 0;
  for (const cat of state.categories) {
    const overlap = cat.words.filter((w) => guessSet.has(w)).length;
    if (overlap > best) best = overlap;
  }
  return best;
}

function submitGuess() {
  if (state.selected.size !== 4 || state.over) return;
  const guess = [...state.selected];
  const guessSet = new Set(guess);

  const match = state.categories.find((cat) => {
    if (cat.words.length !== 4) return false;
    return cat.words.every((w) => guessSet.has(w));
  });

  state.turns++;

  if (match) {
    // Stage 1: flash the tiles green in place ...
    guess.forEach((w) => state.flashCorrect.add(w));
    state.selected.clear();
    messageEl.textContent = `"${match.theme}" – nice find!`;
    messageEl.style.color = "var(--correct)";
    render();

    // ... stage 2: actually remove them, which lets everything above fall.
    setTimeout(() => {
      guess.forEach((w) => state.flashCorrect.delete(w));
      guess.forEach((w) => removeWord(w));
      guess.forEach((w) => state.targets.delete(w));
      addSolvedEntry({ words: guess, theme: match.theme });

      if (state.targets.size === 0) {
        state.over = true;
        state.overReason = "won";
        showEndOverlay("Solved!", `You cleared all the red words in ${state.turns} turns.`);
      } else if (findShortestSolution(state.columns, state.targets, state.categories) === null) {
        state.over = true;
        state.overReason = "stuck";
        showEndOverlay(
          "No path to victory",
          `No sequence of guesses can clear the remaining red words from here. Game over after ${state.turns} turns.`
        );
      }
      render();
    }, 350);
  } else {
    const n = bestOverlapCount(guessSet);
    messageEl.textContent = n > 0
      ? `Not quite — you got ${n} right.`
      : "None of those belong together.";
    messageEl.style.color = "var(--incorrect)";
    flashIncorrect(guess);
    // leave the guess selected — the player deselects manually if they want to change it
    render();
  }
}

function showEndOverlay(title, message) {
  overlayTitle.textContent = title;
  overlayMessage.textContent = message;
  setTimeout(() => endOverlay.classList.remove("hidden"), 500);
}

function addSolvedEntry(entry) {
  state.solved.push(entry);
  solvedEmpty.hidden = true;
  const li = document.createElement("li");
  li.className = "solved-item";
  const theme = document.createElement("p");
  theme.className = "theme";
  theme.textContent = entry.theme;
  const words = document.createElement("div");
  words.className = "words";
  entry.words.forEach((w) => {
    const span = document.createElement("span");
    span.textContent = w;
    words.appendChild(span);
  });
  li.appendChild(theme);
  li.appendChild(words);
  solvedList.appendChild(li);
}

function removeWord(word) {
  const pos = findPosition(word);
  if (!pos) return;
  state.columns[pos.c].splice(pos.i, 1); // everything above shifts down automatically
}

function flashIncorrect(words) {
  words.forEach((w) => {
    const el = els.get(w);
    if (!el) return;
    el.classList.add("incorrect");
    el.addEventListener("animationend", () => el.classList.remove("incorrect"), { once: true });
  });
}

// ---------- rendering (FLIP animation so tiles visibly fall) ----------

function render() {
  const firstRects = new Map();
  els.forEach((el, word) => firstRects.set(word, el.getBoundingClientRect()));

  const currentWords = new Set();
  state.columns.forEach((col) => col.forEach((w) => currentWords.add(w)));

  // pop/fade out tiles that were just cleared from the board
  els.forEach((el, word) => {
    if (!currentWords.has(word)) {
      el.classList.add("cleared");
      el.addEventListener("animationend", () => el.remove(), { once: true });
      els.delete(word);
    }
  });

  state.columns.forEach((col, c) => {
    col.forEach((w, i) => {
      let el = els.get(w);
      if (!el) {
        el = document.createElement("button");
        el.className = "tile";
        el.type = "button";
        el.textContent = w;
        el.addEventListener("click", () => onTileClick(w));
        board.appendChild(el);
        els.set(w, el);
      }
      el.style.gridRow = 6 - i;
      el.style.gridColumn = c + 1;
      el.classList.toggle("locked", i >= 4);
      el.classList.toggle("selected", state.selected.has(w));
      el.classList.toggle("target", state.targets.has(w));
      el.classList.toggle("correct", state.flashCorrect.has(w));
    });
  });

  requestAnimationFrame(() => {
    els.forEach((el, word) => {
      const first = firstRects.get(word);
      if (!first) return; // brand new tile, no previous position to animate from
      const last = el.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (!dx && !dy) return;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)";
        el.style.transform = "";
        el.addEventListener("transitionend", () => {
          el.classList.add("settle");
          el.addEventListener("animationend", () => el.classList.remove("settle"), { once: true });
        }, { once: true });
      });
    });
  });

  turnCountEl.textContent = state.turns;
  targetCountEl.textContent = state.targets.size;
  submitBtn.disabled = state.selected.size !== 4;
  deselectBtn.disabled = state.selected.size === 0;
}

init();
