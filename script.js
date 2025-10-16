/* script.js

Coiny Road - Single-file modular game code.

Structure:
- Constants & tweakables (DIFFICULTY CONSTANTS) at top for easy tuning.
- Utilities: input handlers (keyboard, swipe, touch buttons), audio manager, helpers.
- Core classes:
  - Game: orchestrates loop, state, spawn, UI hooks.
  - World / Row: procedural generation, lane types, visuals.
  - Player: coin actor with movement, hops, skins.
  - ObstaclePool: object pooling for cars, logs, trains.
  - ParticleSystem: simple particle effects.
- Rendering: canvas-based drawing, retina scaling, parallax layers.
- Persistence: localStorage for best score, coins, unlocked skins.
- Accessibility: ARIA updates, respects prefers-reduced-motion.

How to run:
- Save this file as script.js, open index.html in a browser (no server required).
- Tweak difficulty in DIFFICULTY block below.

DIFFICULTY constants (quick guide):
- BASE_SPEED: base speed multiplier for obstacles
- SPAWN_RATE: average rows generated per second at start
- SAFE_ROW_PROB: probability a new row is grass/sidewalk
- DIFFICULTY_RAMP: how quickly speed/spawn scale over distance
*/

(() => {
  'use strict';

  /* ==========================
     DIFFICULTY & TWEAKABLES
     ========================== */
  const DIFF = {
    BASE_SPEED: 80,           // base pixels/sec for obstacle lanes
    SPEED_RAMP: 0.007,        // how quickly obstacle speed increases per distance
    SPAWN_BASE: 1.2,          // base rows per second generated
    SPAWN_RAMP: 0.002,        // spawn increase per distance
    SAFE_ROW_PROB: 0.42,      // initial probability of safe rows
    SPECIAL_ROW_RATE: 0.03,   // chance of special row (slippery/slow)
    COIN_SPAWN_CHANCE: 0.07,  // chance to spawn a coin in a row
    TRAIN_CHANCE: 0.04,       // chance for a train track row
    RIVER_CHANCE: 0.12,
    ROAD_CHANCE: 0.28,
    SIDEWALK_CHANCE: 0.14,
    MAX_LANE_SPEED: 320,      // cap for obstacle speeds
    LANE_HEIGHT: 64,          // visual height per row (in CSS pixels before scaling)
    POOL_SIZE: 60,            // pooled objects for obstacles/logs/trains
  };

  /* ==========================
     References to DOM Elements
     ========================== */
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d', { alpha: true });
  const scoreValue = document.getElementById('scoreValue');
  const bestValue = document.getElementById('bestValue');
  const coinCountEl = document.getElementById('coinCount');
  const coinSmall = document.getElementById('coinSmall');
  const soundBtn = document.getElementById('soundBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const startBtn = document.getElementById('startBtn');
  const tutorial = document.getElementById('tutorial');
  const skipTutorialCheckbox = document.getElementById('skipTutorial');
  const pauseOverlay = document.getElementById('pauseOverlay');
  const resumeBtn = document.getElementById('resumeBtn');
  const restartBtn = document.getElementById('restartBtn');
  const gameOver = document.getElementById('gameOver');
  const finalScore = document.getElementById('finalScore');
  const finalBest = document.getElementById('finalBest');
  const finalCoins = document.getElementById('finalCoins');
  const retryBtn = document.getElementById('retryBtn');
  const toMenuBtn = document.getElementById('toMenuBtn');
  const soundToggleBtn = soundBtn;
  const dirButtons = document.querySelectorAll('.dir-btn');
  const skinGrid = document.getElementById('skinGrid');
  const localScoresList = document.getElementById('localScores');
  const srStatus = document.getElementById('srStatus');

  /* ==========================
     Persistence Keys & Defaults
     ========================== */
  const STORAGE_KEYS = {
    BEST: 'coinyroad_best',
    COINS: 'coinyroad_coins',
    SKINS: 'coinyroad_skins',
    LOCAL_SCORES: 'coinyroad_local_scores',
    PREFS: 'coinyroad_prefs'
  };

  /* ==========================
     Audio Manager (Web Audio)
     ========================== */
  class AudioManager {
    constructor() {
      this.enabled = true;
      this.initAudio();
      // Respect prefers-reduced-motion
      this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (this.reduced) this.enabled = false;
    }
    initAudio() {
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        this.ctx = null;
        this.enabled = false;
      }
    }
    toggle() {
      this.enabled = !this.enabled;
      if (this.enabled && this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      soundToggleBtn.textContent = this.enabled ? '🔊' : '🔇';
    }
    beep(freq = 880, type = 'sine', duration = 0.06, gain = 0.12) {
      if (!this.enabled || !this.ctx) return;
      const now = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, now);
      g.gain.setValueAtTime(gain, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      o.connect(g);
      g.connect(this.ctx.destination);
      o.start(now);
      o.stop(now + duration + 0.02);
    }
    pop() { this.beep(1200, 'triangle', 0.04, 0.08); }
    coin() { this.beep(1400, 'sine', 0.08, 0.12); }
    crash() { this.beep(180, 'sawtooth', 0.3, 0.22); }
  }
  const audio = new AudioManager();

  /* ==========================
     Utilities
     ========================== */
  const Utils = {
    rand(min, max) { return Math.random() * (max - min) + min; },
    randint(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; },
    clamp(v, a, b) { return Math.max(a, Math.min(b, v)); },
    chooseWeighted(choices) {
      // choices: [{item, weight}, ...]
      const sum = choices.reduce((s, c) => s + c.weight, 0);
      let r = Math.random() * sum;
      for (const c of choices) {
        if (r < c.weight) return c.item;
        r -= c.weight;
      }
      return choices[choices.length - 1].item;
    },
    rectsOverlap(a, b) {
      return !(a.x + a.w <= b.x || a.x >= b.x + b.w || a.y + a.h <= b.y || a.y >= b.y + b.h);
    },
    now() { return performance.now(); }
  };

  /* ==========================
     High DPI canvas scaling
     ========================== */
  function resizeCanvasToDisplaySize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(300, Math.floor(rect.width));
    const h = Math.max(240, Math.floor(rect.height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ==========================
     Simple object pooling
     ========================== */
  class Pool {
    constructor(createFn, size = 64) {
      this.createFn = createFn;
      this.pool = [];
      for (let i = 0; i < size; i++) this.pool.push(createFn());
    }
    acquire() {
      return this.pool.length ? this.pool.pop() : this.createFn();
    }
    release(obj) {
      if (obj.reset) obj.reset();
      this.pool.push(obj);
    }
  }

  /* ==========================
     Particle system
     ========================== */
  class Particle {
    constructor() {
      this.active = false;
      this.x = this.y = 0;
      this.vx = this.vy = 0;
      this.life = 0;
      this.size = 1;
      this.color = '#fff';
    }
    reset() { this.active = false; }
    spawn(x, y, vx, vy, life, size, color) {
      this.active = true; this.x = x; this.y = y; this.vx = vx; this.vy = vy; this.life = life; this.size = size; this.color = color;
    }
    update(dt) {
      if (!this.active) return;
      this.life -= dt;
      if (this.life <= 0) { this.active = false; return; }
      this.x += this.vx * dt; this.y += this.vy * dt;
      // gravity
      this.vy += 400 * dt;
    }
    draw(ctx) {
      if (!this.active) return;
      ctx.save();
      ctx.globalAlpha = Math.max(0, this.life / 0.6);
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /* ==========================
     Row & Lane Types
     ========================== */
  const LaneTypes = {
    GRASS: 'grass',
    ROAD: 'road',
    RIVER: 'river',
    TRAIN: 'train',
    SIDEWALK: 'sidewalk',
    SPECIAL_SLOW: 'slow',
    SPECIAL_SLIPPERY: 'slippery'
  };

  /* ==========================
     Obstacle / Log / Train representation
     ========================== */
  function createObstacle() {
    return {
      active: false,
      x: 0, y: 0, w: 40, h: 40,
      vx: 0,
      type: 'car', // car/log/train
      sprite: null,
      reset() {
        this.active = false;
        this.vx = 0;
      }
    };
  }

  /* ==========================
     World generator & row class
     ========================== */
  class Row {
    constructor(idx, y, height, type, speed, seed) {
      this.idx = idx; // vertical index relative to start
      this.y = y;     // y position in world coordinates
      this.h = height;
      this.type = type;
      this.speed = speed;
      this.seed = seed || Math.random();
      this.obstacles = []; // will hold references to pooled obstacles
      this.coin = null; // coin position if spawn coin
    }
  }

  /* ==========================
     Player (the coin)
     ========================== */
  class Player {
    constructor(skins) {
      this.x = 0; this.y = 0; // grid coords (col, row)
      this.px = 0; this.py = 0; // pixel position on canvas
      this.gridSize = 64;
      this.target = null; // target grid pos for movement smoothing
      this.isMoving = false;
      this.moveTime = 0.18; // seconds
      this.moveElapsed = 0;
      this.animOffsetY = 0;
      this.skin = 0;
      this.skins = skins || this.defaultSkins();
      this.onLog = null; // reference to obstacle if on a log
    }
    defaultSkins(){
      // simple skin descriptions: color gradient/style
      return [
        { name: 'Classic', draw: (ctx, x, y, r) => {
            // shiny gold coin
            const g = ctx.createRadialGradient(x - 6, y - 6, r*0.2, x, y, r);
            g.addColorStop(0, '#fff6d0'); g.addColorStop(0.3, '#ffea8a'); g.addColorStop(1, '#c98f02');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
            // edge
            ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.stroke();
            // shine
            ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath();
            ctx.ellipse(x - r*0.35, y - r*0.45, r*0.45, r*0.22, -0.6, 0, Math.PI*2); ctx.fill();
          }},
        { name: 'Bronze', draw: (ctx,x,y,r)=>{ ctx.fillStyle='#c67c3d'; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); ctx.strokeStyle='rgba(255,255,255,0.08)'; ctx.lineWidth=2; ctx.stroke(); }},
        { name: 'Emerald', draw: (ctx,x,y,r)=>{ ctx.fillStyle='#1abc9c'; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); }},
        { name: 'Silver', draw: (ctx,x,y,r)=>{ ctx.fillStyle='#cbd5df'; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); }},
        { name: 'Pixel', draw: (ctx,x,y,r)=>{ // pixel style
            const size = Math.max(2, Math.floor(r/3));
            for(let yy=-2;yy<=2;yy++) for(let xx=-2;xx<=2;xx++){
              ctx.fillStyle = ((xx+yy)%2===0)?'#ffd24a':'#d9a00d';
              ctx.fillRect(x+xx*size, y+yy*size, size, size);
            }
          }}
      ];
    }
    setGrid(x, y){
      this.x = x; this.y = y;
      this.px = x * this.gridSize;
      this.py = y * this.gridSize;
    }
    moveBy(dx, dy){
      if (this.isMoving) return false;
      this.target = { x: this.x + dx, y: this.y + dy };
      this.isMoving = true; this.moveElapsed = 0;
      audio.pop();
      return true;
    }
    update(dt){
      if (this.isMoving && this.target) {
        this.moveElapsed += dt;
        const t = Math.min(1, this.moveElapsed / this.moveTime);
        // ease out cubic
        const ease = 1 - Math.pow(1 - t, 3);
        const nx = (this.x + (this.target.x - this.x) * ease) * this.gridSize;
        const ny = (this.y + (this.target.y - this.y) * ease) * this.gridSize;
        // hop effect: parabola
        const hop = Math.sin(ease * Math.PI) * 12;
        this.px = nx; this.py = ny - hop;
        if (t >= 1) {
          // finalize
          this.x = this.target.x; this.y = this.target.y; this.isMoving = false; this.target = null; this.px = this.x * this.gridSize; this.py = this.y * this.gridSize;
        }
      }
      // if riding a log, translation handled externally
    }
    draw(ctx, cx, cy, scale) {
      // cx,cy = pixel position on canvas to draw
      const r = Math.max(10, this.gridSize * 0.32) * scale;
      // Provide a slight shadow
      ctx.save();
      ctx.translate(cx, cy);
      // shadow
      ctx.beginPath();
      ctx.ellipse(0, r*0.85, r*0.9, r*0.33, 0, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fill();
      // draw skin
      ctx.translate(0, -4 * scale);
      const skin = this.skins[this.skin % this.skins.length];
      skin.draw(ctx, 0, 0, r);
      ctx.restore();
    }
  }

  /* ==========================
     Game class - orchestrates everything
     ========================== */
  class Game {
    constructor() {
      this.running = false;
      this.paused = false;
      this.lastTime = 0;
      this.accum = 0;
      this.rows = []; // visible rows (from bottom to top)
      this.rowHeight = DIFF.LANE_HEIGHT;
      this.cols = 7; // number of columns visible horizontally
      this.gridOffsetX = 0; // center alignment
      this.player = null;
      this.particlePool = new Pool(() => new Particle(), 120);
      this.particles = [];
      this.obstaclePool = new Pool(createObstacle, DIFF.POOL_SIZE);
      this.activeObstacles = [];
      this.distance = 0; // rows advanced (score)
      this.best = parseInt(localStorage.getItem(STORAGE_KEYS.BEST) || '0', 10);
      bestValue.textContent = this.best;
      this.coins = parseInt(localStorage.getItem(STORAGE_KEYS.COINS) || '0', 10);
      coinCountEl.textContent = this.coins;
      coinSmall.textContent = this.coins;
      this.skinsUnlocked = JSON.parse(localStorage.getItem(STORAGE_KEYS.SKINS) || '[0]'); // array of unlocked skin indices
      this.prefs = JSON.parse(localStorage.getItem(STORAGE_KEYS.PREFS) || '{}');
      this.lastSpawnedRowIdx = 0;
      this.scrollY = 0; // world scroll offset in pixels
      this.cameraOffset = 0; // for smooth camera
      this.parallax = { sky: 0, distant: 0 };
      this.dpr = window.devicePixelRatio || 1;
      this.setupCanvas();
      this.initPlayer();
      this.setupInput();
      this.setupUI();
      this.generateInitialRows();
      this.initSkinsUI();
      this.readLocalScores();
      // Respect reduced motion
      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    setupCanvas() {
      resizeCanvasToDisplaySize();
      window.addEventListener('resize', () => resizeCanvasToDisplaySize());
    }

    initPlayer() {
      // create player with skins
      this.player = new Player();
      // set unlocked skins into player's skins array
      // For simplicity, player's skins array is the same as default set; unlocking toggles availability
      this.player.skins = this.player.defaultSkins();
      // Start player in central column, near bottom row (index 2)
      this.cols = 7;
      const startCol = Math.floor(this.cols / 2);
      // We'll choose starting grid row such that several rows below for safety
      this.player.setGrid(startCol, 2);
      this.distance = 0;
    }

    setupInput() {
      // Keyboard
      window.addEventListener('keydown', (e) => {
        if (!this.running || this.paused) return;
        const k = e.key.toLowerCase();
        if (['arrowup', 'w', 'k'].includes(e.key) || k === 'w') { this.attemptMove(0, 1); e.preventDefault(); }
        if (['arrowdown', 's', 'j'].includes(e.key) || k === 's') { this.attemptMove(0, -1); e.preventDefault(); }
        if (['arrowleft', 'a', 'h'].includes(e.key) || k === 'a') { this.attemptMove(-1, 0); e.preventDefault(); }
        if (['arrowright', 'd', 'l'].includes(e.key) || k === 'd') { this.attemptMove(1, 0); e.preventDefault(); }
      });

      // On-screen dir buttons
      dirButtons.forEach(b => {
        b.addEventListener('click', (ev) => {
          const dir = b.getAttribute('data-dir');
          if (!this.running || this.paused) return;
          switch (dir) {
            case 'up': this.attemptMove(0, 1); break;
            case 'down': this.attemptMove(0, -1); break;
            case 'left': this.attemptMove(-1, 0); break;
            case 'right': this.attemptMove(1, 0); break;
          }
        });
      });

      // Touch swipe detection
      let touchStart = null;
      canvas.addEventListener('touchstart', (e) => {
        if (!this.running || this.paused) return;
        const t = e.changedTouches[0];
        touchStart = { x: t.clientX, y: t.clientY, time: performance.now() };
      }, { passive: true });
      canvas.addEventListener('touchend', (e) => {
        if (!this.running || this.paused || !touchStart) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - touchStart.x;
        const dy = t.clientY - touchStart.y;
        const dt = performance.now() - touchStart.time;
        // Minimum swipe threshold
        const absDx = Math.abs(dx), absDy = Math.abs(dy);
        const min = 30;
        if (absDx < min && absDy < min) {
          // treat as tap: forward hop
          this.attemptMove(0, 1);
        } else if (absDx > absDy) {
          // horizontal swipe
          if (dx > 0) this.attemptMove(1, 0); else this.attemptMove(-1, 0);
        } else {
          if (dy < 0) this.attemptMove(0, 1); else this.attemptMove(0, -1);
        }
        touchStart = null;
      }, { passive: true });

      // pause / resume
      pauseBtn.addEventListener('click', () => {
        if (!this.running) return;
        if (this.paused) this.resume();
        else this.pause();
      });
    }

    setupUI() {
      // sound toggle
      soundToggleBtn.addEventListener('click', () => { audio.toggle(); });

      // start game (from tutorial)
      startBtn.addEventListener('click', () => {
        if (skipTutorialCheckbox.checked) this.prefs.skipTutorial = true;
        localStorage.setItem(STORAGE_KEYS.PREFS, JSON.stringify(this.prefs));
        tutorial.classList.add('hidden');
        this.start();
      });

      resumeBtn.addEventListener('click', () => this.resume());
      restartBtn.addEventListener('click', () => this.restart());
      retryBtn.addEventListener('click', () => { this.hideGameOver(); this.restart(); });
      toMenuBtn.addEventListener('click', () => { this.hideGameOver(); /* reveal skins area, it's always visible */ });

      // show tutorial unless skipped
      if (this.prefs && this.prefs.skipTutorial) tutorial.classList.add('hidden');
      else tutorial.classList.remove('hidden');

      // initially paused until start
      this.paused = true;
      pauseOverlay.classList.add('hidden');
    }

    initSkinsUI() {
      // Build skins grid
      const skins = this.player.defaultSkins();
      skinGrid.innerHTML = '';
      skins.forEach((s, idx) => {
        const card = document.createElement('div');
        card.className = 'skin-card';
        if (!this.skinsUnlocked.includes(idx)) card.classList.add('locked');
        card.setAttribute('role', 'listitem');
        card.setAttribute('tabindex', '0');
        // draw skin in a mini canvas
        const mini = document.createElement('canvas');
        mini.width = 64; mini.height = 64;
        mini.style.width = '56px'; mini.style.height = '56px';
        const mc = mini.getContext('2d');
        mc.translate(32, 32);
        s.draw(mc, 0, 0, 22);
        card.appendChild(mini);

        const label = document.createElement('div');
        label.className = 'skin-label';
        label.textContent = s.name;
        card.appendChild(label);

        card.addEventListener('click', () => {
          if (!this.skinsUnlocked.includes(idx)) {
            // attempt purchase: cost example: (idx)*5 coins
            const cost = Math.max(6, idx * 6);
            if (this.coins >= cost) {
              this.coins -= cost;
              this.skinsUnlocked.push(idx);
              localStorage.setItem(STORAGE_KEYS.COINS, this.coins);
              localStorage.setItem(STORAGE_KEYS.SKINS, JSON.stringify(this.skinsUnlocked));
              coinCountEl.textContent = this.coins;
              coinSmall.textContent = this.coins;
              card.classList.remove('locked');
              this.announce(`Unlocked ${s.name}`);
            } else {
              this.announce('Not enough coins');
            }
          } else {
            // select skin with small animation
            this.player.skin = idx;
            audio.pop();
            // tiny scale animation on card
            card.animate([{ transform: 'scale(0.98)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
          }
        });

        skinGrid.appendChild(card);
      });
    }

    readLocalScores() {
      const ls = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_SCORES) || '[]');
      localScoresList.innerHTML = '';
      ls.slice(0,6).forEach(s => {
        const li = document.createElement('li');
        li.textContent = s;
        localScoresList.appendChild(li);
      });
    }

    generateInitialRows() {
      this.rows = [];
      // Build initial rows with some safe ground
      const num = Math.ceil((canvas.height / this.rowHeight) + 8);
      for (let i = 0; i < num; i++) {
        const type = (i < 3) ? LaneTypes.GRASS : LaneTypes.SIDEWALK;
        const y = i * this.rowHeight;
        this.rows.unshift(new Row(i, y, this.rowHeight, type, 0));
        this.lastSpawnedRowIdx = i;
      }
    }

    start() {
      if (!this.running) {
        this.running = true;
        this.paused = false;
        this.lastTime = Utils.now();
        this.loop();
      } else {
        this.paused = false;
        this.lastTime = Utils.now();
        this.loop();
      }
    }

    pause() {
      this.paused = true;
      pauseOverlay.classList.remove('hidden');
      this.announce('Paused');
    }

    resume() {
      this.paused = false;
      pauseOverlay.classList.add('hidden');
      this.lastTime = Utils.now();
      this.loop();
      this.announce('Resumed');
    }

    restart() {
      // reset world, player, obstacles
      this.running = true; this.paused = false;
      this.distance = 0;
      scoreValue.textContent = '0';
      this.player.setGrid(Math.floor(this.cols/2), 2);
      this.generateInitialRows();
      this.activeObstacles.length = 0;
      this.lastSpawnedRowIdx = this.rows.length;
      this.scrollY = 0;
      this.cameraOffset = 0;
      this.player.onLog = null;
      audio.pop();
      this.lastTime = Utils.now();
      this.loop();
    }

    endRun() {
      this.running = false;
      audio.crash();
      // update best
      if (this.distance > this.best) { this.best = this.distance; localStorage.setItem(STORAGE_KEYS.BEST, this.best); bestValue.textContent = this.best;}
      // award collected coins already handled
      finalScore.textContent = this.distance;
      finalBest.textContent = this.best;
      finalCoins.textContent = this.coins;
      // store local scores
      const scores = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_SCORES) || '[]');
      scores.unshift(this.distance);
      localStorage.setItem(STORAGE_KEYS.LOCAL_SCORES, JSON.stringify(scores.slice(0,30)));
      this.readLocalScores();
      // show modal
      gameOver.classList.remove('hidden');
    }

    hideGameOver() {
      gameOver.classList.add('hidden');
    }

    attemptMove(dx, dy) {
      // dx: col change, dy: row change (up is +1)
      // keep within columns
      const targetX = this.player.x + dx;
      const targetY = this.player.y + dy;
      if (targetX < 0 || targetX >= this.cols || targetY < 0) return;
      // moving forward (up) increases distance
      if (dy > 0) {
        this.distance += 1;
        scoreValue.textContent = this.distance;
      }
      // if moving forward beyond visible top, scroll world
      if (this.player.isMoving === false) {
        this.player.moveBy(dx, dy);
        // If forward, scroll camera
        if (dy > 0) {
          // schedule world shift after move completes
          setTimeout(() => this.shiftWorldByRows(1), this.player.moveTime * 1000 * 0.6);
        }
      }
    }

    shiftWorldByRows(n) {
      // move world down visually and generate n new rows on top
      for (let i = 0; i < n; i++) {
        // increment last index
        this.lastSpawnedRowIdx++;
        const y = this.rows.length * this.rowHeight;
        const choice = this.chooseRowType();
        const speed = this.computeLaneSpeed();
        const row = new Row(this.lastSpawnedRowIdx, y, this.rowHeight, choice, speed);
        // maybe spawn coin
        if (Math.random() < DIFF.COIN_SPAWN_CHANCE) {
          // coin grid position random col
          const col = Utils.randint(0, this.cols - 1);
          row.coin = { col, collected: false };
        }
        this.rows.push(row);
        // spawn obstacles based on type
        this.populateRowWithObstacles(row);
      }
      // move rows down visually by reducing player.y by 1 (player stays grid-wise same)
      // instead, we adjust row indices and remove bottom row if too many
      // remove rows that are off-screen (below)
      while (this.rows.length > Math.ceil((canvas.height / this.rowHeight) + 12)) {
        this.rows.shift();
      }
    }

    chooseRowType() {
      // difficulty influences probabilities
      const ramp = 1 + this.distance * DIFF.SPAWN_RAMP;
      const safeProb = Utils.clamp(DIFF.SAFE_ROW_PROB - (this.distance * 0.0008), 0.18, 0.6);
      const choices = [
        { item: LaneTypes.GRASS, weight: safeProb * 100 },
        { item: LaneTypes.SIDEWALK, weight: DIFF.SIDEWALK_CHANCE * 100 },
        { item: LaneTypes.ROAD, weight: DIFF.ROAD_CHANCE * 100 },
        { item: LaneTypes.RIVER, weight: DIFF.RIVER_CHANCE * 100 },
        { item: LaneTypes.TRAIN, weight: DIFF.TRAIN_CHANCE * 100 },
        { item: LaneTypes.SPECIAL_SLIPPERY, weight: DIFF.SPECIAL_ROW_RATE * 100 * ramp },
        { item: LaneTypes.SPECIAL_SLOW, weight: DIFF.SPECIAL_ROW_RATE * 90 * ramp }
      ];
      return Utils.chooseWeighted(choices);
    }

    computeLaneSpeed() {
      const base = DIFF.BASE_SPEED + (this.distance * DIFF.SPEED_RAMP * 1000);
      return Math.min(DIFF.MAX_LANE_SPEED, base * (1 + Math.random() * 0.5));
    }

    populateRowWithObstacles(row) {
      // depending on row type, spawn obstacles
      const laneY = row.y;
      if (row.type === LaneTypes.ROAD) {
        // spawn multiple cars with varying spacing
        const count = Utils.randint(2, 4);
        for (let i = 0; i < count; i++) {
          const obs = this.obstaclePool.acquire();
          obs.active = true;
          obs.type = 'car';
          obs.w = Utils.randint(42, 78);
          obs.h = this.rowHeight * 0.7;
          obs.y = laneY + (this.rowHeight - obs.h) / 2;
          // set direction randomly
          const dir = Math.random() < 0.5 ? -1 : 1;
          if (dir > 0) obs.x = -i * 160 - Math.random()*200;
          else obs.x = canvas.width + i * 160 + Math.random()*200;
          obs.vx = dir * row.speed * (0.9 + Math.random()*0.7);
          row.obstacles.push(obs);
          this.activeObstacles.push(obs);
        }
      } else if (row.type === LaneTypes.RIVER) {
        const count = Utils.randint(2, 4);
        for (let i = 0; i < count; i++) {
          const obs = this.obstaclePool.acquire();
          obs.active = true;
          obs.type = 'log';
          obs.w = Utils.randint(80, 170);
          obs.h = this.rowHeight * 0.85;
          obs.y = laneY + (this.rowHeight - obs.h) / 2;
          const dir = Math.random() < 0.5 ? -1 : 1;
          if (dir > 0) obs.x = -i * 220 - Math.random()*300;
          else obs.x = canvas.width + i * 220 + Math.random()*300;
          obs.vx = dir * (row.speed * (0.5 + Math.random()*0.6));
          row.obstacles.push(obs);
          this.activeObstacles.push(obs);
        }
      } else if (row.type === LaneTypes.TRAIN) {
        // fewer but dangerous trains; trains are long
        const obs = this.obstaclePool.acquire();
        obs.active = true;
        obs.type = 'train';
        obs.w = Utils.randint(260, 520);
        obs.h = this.rowHeight * 0.9;
        obs.y = laneY + (this.rowHeight - obs.h) / 2;
        const dir = Math.random() < 0.5 ? -1 : 1;
        if (dir > 0) obs.x = -Math.random()*800 - 300;
        else obs.x = canvas.width + Math.random()*800 + 300;
        obs.vx = dir * (row.speed * (1.2 + Math.random()*0.6));
        row.obstacles.push(obs);
        this.activeObstacles.push(obs);
      } else {
        // grass/sidewalk/special: fewer obstacles (decoration)
        if (Math.random() < 0.18) {
          const obs = this.obstaclePool.acquire();
          obs.active = true;
          obs.type = 'trash';
          obs.w = Utils.randint(18, 32);
          obs.h = this.rowHeight * 0.5;
          obs.y = laneY + (this.rowHeight - obs.h) / 2;
          obs.x = Utils.randint(20, canvas.width - 40);
          obs.vx = 0;
          row.obstacles.push(obs);
          this.activeObstacles.push(obs);
        }
      }
    }

    updateObstacles(dt) {
      // update positions, recycle off-screen
      const width = canvas.width;
      for (let i = this.activeObstacles.length - 1; i >= 0; i--) {
        const o = this.activeObstacles[i];
        if (!o.active) { this.activeObstacles.splice(i, 1); continue; }
        o.x += o.vx * dt;
        // recycle if completely off screen for simplicity
        if (o.vx > 0 && o.x > width + 300) {
          o.active = false; this.obstaclePool.release(o);
          this.activeObstacles.splice(i, 1);
        } else if (o.vx < 0 && o.x + o.w < -300) {
          o.active = false; this.obstaclePool.release(o);
          this.activeObstacles.splice(i, 1);
        }
      }
    }

    updateParticles(dt) {
      // update active particles list
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.update(dt);
        if (!p.active) {
          this.particlePool.release(p);
          this.particles.splice(i, 1);
        }
      }
    }

    spawnParticles(x, y, amount=12, color='#ffd24a') {
      for (let i = 0; i < amount; i++) {
        const p = this.particlePool.acquire();
        const angle = Utils.rand(0, Math.PI * 2);
        const speed = Utils.rand(60, 260);
        p.spawn(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed * 0.6, Utils.rand(0.35, 0.8), Utils.rand(1.5, 3.6), color);
        this.particles.push(p);
      }
    }

    update(dt) {
      if (!this.running || this.paused) return;
      // Update player
      this.player.update(dt);
      // Update obstacles
      this.updateObstacles(dt);
      // Update particles
      this.updateParticles(dt);
      // Update parallax slowly
      this.parallax.sky += dt * 2;
      this.parallax.distant += dt * 6;
      // Update rows' obstacle positions (they already move via obstacle.vx)
      // Check collisions & interactions
      this.handleInteractions();
    }

    handleInteractions() {
      // Determine player's pixel position
      const pcol = this.player.x;
      const prow = this.player.y;
      // compute world row index (rows array bottom-to-top)
      // We store rows with y increasing; we can find the row closest to player's grid y (player at low index near bottom)
      // Simpler: map player's grid y to rows[?] by assuming bottom-most visible row corresponds to player y = 0
      const rowIndex = this.rows.length - 1 - (this.player.y);
      const row = this.rows[rowIndex] || null;

      // 1) Collect coin if present in row
      if (row && row.coin && !row.coin.collected) {
        if (row.coin.col === this.player.x) {
          row.coin.collected = true;
          this.coins += 1; localStorage.setItem(STORAGE_KEYS.COINS, this.coins);
          coinCountEl.textContent = this.coins; coinSmall.textContent = this.coins;
          this.spawnParticles(this.player.px + this.player.gridSize/2, canvas.height - (this.player.py + this.player.gridSize/2), 16, '#ffd24a');
          audio.coin();
        }
      }

      // 2) If row is ROAD or TRAIN - check car/train collisions
      if (row && (row.type === LaneTypes.ROAD || row.type === LaneTypes.TRAIN)) {
        // compute player's bounding box in world (approx)
        const px = this.player.px;
        const py = canvas.height - (this.player.py + this.player.gridSize); // convert to canvas y-space (origin top-left)
        const playerBB = { x: px + 8, y: py + 6, w: this.player.gridSize - 16, h: this.player.gridSize - 12 };
        // check against obstacles that belong to this row (we didn't store mapping, so check activeObstacles with approximate y range)
        for (const o of this.activeObstacles) {
          if (!o.active) continue;
          // if obstacle's y overlaps with player's canvas y
          if (o.y + o.h < py || o.y > py + playerBB.h) continue;
          const obb = { x: o.x, y: o.y, w: o.w, h: o.h };
          if (Utils.rectsOverlap(playerBB, obb)) {
            // collision -> end run
            this.endRun();
            return;
          }
        }
      } else if (row && row.type === LaneTypes.RIVER) {
        // If river: player must be on a log (within its bounds). If not, drown -> endRun
        // Determine absolute player canvas coordinates to match obstacle positions
        const px = this.player.px;
        const py = canvas.height - (this.player.py + this.player.gridSize);
        let onLog = false;
        for (const o of this.activeObstacles) {
          if (!o.active || o.type !== 'log') continue;
          if (o.y + o.h < py || o.y > py + this.player.gridSize) continue;
          if (px + this.player.gridSize/2 >= o.x && px + this.player.gridSize/2 <= o.x + o.w) {
            // The player is on the log; ride with log horizontally
            onLog = true;
            // Move player's pixel x by log's dx
            this.player.px += o.vx * (1/60); // small step; approximated
            break;
          }
        }
        if (!onLog && !this.player.isMoving) {
          // only drown if not jumping. If jumping in the air over river, we should check after landing — simplified here:
          this.endRun();
        }
      }
    }

    draw() {
      const w = canvas.width / (window.devicePixelRatio || 1);
      const h = canvas.height / (window.devicePixelRatio || 1);
      ctx.clearRect(0, 0, w, h);

      // compute drawing scale based on rowHeight and canvas
      const gridH = this.rowHeight;
      const cols = this.cols;
      const cellW = w / cols;
      const cellH = gridH;

      // background sky / parallax
      this.drawParallax(w, h);

      // translate origin so bottom-left is (0,0)
      ctx.save();
      // draw rows bottom to top
      const visibleRows = Math.ceil(h / this.rowHeight) + 6;
      const baseY = h - this.rowHeight; // y position of player y=0 row
      for (let i = 0; i < this.rows.length; i++) {
        const row = this.rows[i];
        const rowScreenY = baseY - ((this.rows.length - 1 - i) * this.rowHeight);
        // lane background
        this.drawRowBackground(row, rowScreenY, w);
      }

      // draw obstacles
      for (const o of this.activeObstacles) {
        if (!o.active) continue;
        // find its screen y = o.y (we used row.y as coordinate earlier anchored to top of world), but we treated row.y as index * rowHeight
        // Compute mapping: rows[?].y to screen y. Simplify: recalc rowScreenY by finding nearest row with matching y
        const rowIdx = this.rows.findIndex(r => r.y === o.y);
        const oScreenY = (rowIdx >= 0) ? (baseY - ((this.rows.length - 1 - rowIdx) * this.rowHeight)) + (o.y % this.rowHeight || 0) : o.y;
        ctx.save();
        // draw car/log/train differently
        if (o.type === 'car') {
          // car body
          ctx.fillStyle = '#ff6b6b';
          ctx.fillRect(o.x, oScreenY + (this.rowHeight - o.h)/2, o.w, o.h);
          // windows
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.fillRect(o.x + 8, oScreenY + (this.rowHeight - o.h)/2 + 8, Math.max(8, o.w - 40), Math.max(8, o.h - 20));
        } else if (o.type === 'log') {
          // log style
          ctx.fillStyle = '#6b3f11';
          ctx.fillRect(o.x, oScreenY + (this.rowHeight - o.h)/2, o.w, o.h);
          // lines
          ctx.fillStyle = '#8b5a2b';
          for (let s = 0; s < Math.floor(o.w / 20); s++) {
            ctx.fillRect(o.x + s * 20 + 4, oScreenY + (this.rowHeight - o.h)/2 + 6, 6, o.h - 12);
          }
        } else if (o.type === 'train') {
          ctx.fillStyle = '#1f6feb';
          ctx.fillRect(o.x, oScreenY + (this.rowHeight - o.h)/2, o.w, o.h);
          // stripes
          ctx.fillStyle = '#fff';
          ctx.fillRect(o.x + 10, oScreenY + (this.rowHeight - o.h)/2 + 6, Math.max(8, o.w - 20), 6);
        } else if (o.type === 'trash') {
          ctx.fillStyle = '#999';
          ctx.fillRect(o.x, oScreenY + (this.rowHeight - o.h)/2 + 6, o.w, o.h - 12);
        }
        ctx.restore();
      }

      // draw coins on rows
      for (const row of this.rows) {
        if (!row.coin) continue;
        const rowIdx = this.rows.indexOf(row);
        const rowScreenY = baseY - ((this.rows.length - 1 - rowIdx) * this.rowHeight);
        const cx = (row.coin.col + 0.5) * cellW;
        const cy = rowScreenY + this.rowHeight / 2;
        if (!row.coin.collected) {
          // draw coin
          ctx.save();
          ctx.translate(cx, cy);
          ctx.beginPath();
          ctx.fillStyle = '#ffd24a';
          ctx.arc(0, 0, 12, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      // draw player (coin)
      const playerScreenX = (this.player.px / this.player.gridSize + 0.5) * cellW;
      const playerScreenY = baseY - (this.player.y * this.rowHeight) - (this.player.gridSize - this.rowHeight) / 2 - (this.player.px * 0 * 0);
      // note: simpler mapping: use player's px,py mapped into canvas coordinates directly
      const px = this.player.px + this.player.gridSize/2;
      const py = h - (this.player.py + this.player.gridSize/2);
      this.player.draw(ctx, px, py, Math.min(cellW / this.player.gridSize, 1));

      // draw particles
      for (const p of this.particles) p.draw(ctx);

      ctx.restore();
    }

    drawParallax(w, h) {
      // sky gradient / sun/moon
      ctx.save();
      // sky rectangle
      const dayPhase = (Math.sin(this.distance * 0.02 + this.parallax.sky * 0.01) + 1) * 0.5;
      const skyColor = `rgba(${20 + dayPhase * 40}, ${38 + dayPhase * 60}, ${58 + dayPhase * 120}, 1)`;
      ctx.fillStyle = skyColor;
      ctx.fillRect(0, 0, w, h);
      // distant silhouettes
      ctx.fillStyle = 'rgba(8,12,20,0.8)';
      const baseH = h * 0.38;
      // draw blocky city/tree silhouettes using simple rectangles
      for (let i = 0; i < 14; i++) {
        const x = (i * 130 + (this.parallax.distant * 8 % 130) ) % (w + 200) - 100;
        const hh = 40 + ((i % 3) * 20);
        ctx.fillRect(x, baseH - hh, 80, hh);
      }
      ctx.restore();
    }

    loop() {
      if (!this.running || this.paused) return;
      const now = Utils.now();
      const dt = Math.min(0.032, (now - this.lastTime) / 1000);
      this.lastTime = now;

      // update
      this.update(dt);

      // physics step: update obstacles positions according to dt (outside updateObstacles for pooled objects)
      for (const o of this.activeObstacles) {
        o.x += o.vx * dt;
      }

      // cleanup offscreen obstacles - handled in updateObstacles
      this.updateObstacles(dt);

      // render
      this.draw();

      // next frame
      requestAnimationFrame(() => this.loop());
    }

    announce(text) {
      srStatus.textContent = text;
      setTimeout(() => { srStatus.textContent = ''; }, 2000);
    }
  }

  /* ==========================
     Initialize game instance
     ========================== */
  const game = new Game();

  // Hook start from tutorial or immediate start if skipped
  if (game.prefs && game.prefs.skipTutorial) {
    tutorial.classList.add('hidden');
    game.start();
  } else {
    tutorial.classList.remove('hidden');
  }

  // Basic accessibility announcements
  function updateBestUI() { bestValue.textContent = game.best; }

  // ensure screen resizes canvas properly
  window.addEventListener('resize', () => {
    resizeCanvasToDisplaySize();
  });

  // small debugging: log instructions to console
  console.log('Coiny Road: Open index.html to play. Tweak DIFF object at top of script.js to adjust difficulty.');

  // Expose minimal controls for dev via window
  window.Coiny = {
    game,
    DIFF,
    audio
  };

})();
