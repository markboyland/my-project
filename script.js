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
const targetCountEl = document.getElementById("targetCount");
const messageEl = document.getElementById("message");
const submitBtn = document.getElementById("submitBtn");
const deselectBtn = document.getElementById("deselectBtn");
const newGameBtn = document.getElementById("newGameBtn");
const endOverlay = document.getElementById("endOverlay");
const overlayTitle = document.getElementById("overlayTitle");
const overlayMessage = document.getElementById("overlayMessage");
const playAgainBtn = document.getElementById("playAgainBtn");
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
}

function startNewGame() {
  els.forEach((el) => el.remove());
  els.clear();

  const words = pickBoardWords(24);
  state.columns = distributeIntoColumns(words);
  state.targets = pickTargets(state.columns);
  state.selected = new Set();
  state.flashCorrect = new Set();
  state.solved = [];
  state.turns = 0;
  state.over = false;
  state.overReason = null;

  endOverlay.classList.add("hidden");
  messageEl.textContent = "";
  solvedList.innerHTML = "";
  solvedEmpty.hidden = false;
  render();
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

// Is there still at least one category whose 4 words are all present
// somewhere on the board (playable or locked)? If not, no future guess
// can ever succeed and the game is stuck.
function hasAnySolvableCategory() {
  const remaining = new Set();
  state.columns.forEach((col) => col.forEach((w) => remaining.add(w)));
  return state.categories.some((cat) => cat.words.every((w) => remaining.has(w)));
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
      } else if (!hasAnySolvableCategory()) {
        state.over = true;
        state.overReason = "stuck";
        showEndOverlay(
          "No categories left",
          `The remaining words don't form any known category. Game over after ${state.turns} turns.`
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
    state.selected.clear();
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
