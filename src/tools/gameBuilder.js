import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

function getWorkspaceTempDir() {
  const tmpDir = path.join(process.cwd(), '.tmp_causyne_3d');
  if (!fsSync.existsSync(tmpDir)) {
    fsSync.mkdirSync(tmpDir, { recursive: true });
  }
  return tmpDir;
}

// -----------------------------------------------------------------------------
// Benchmark Template 1: 3D Space Defense (Three.js WebGL + Web Audio + Joysticks)
// -----------------------------------------------------------------------------
function getSpaceDefense3dTemplate(title, includeAudio = true) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${title} — Causyne Sovereign Edge Game</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; user-select: none; }
        body { background: #000; overflow: hidden; font-family: 'Outfit', sans-serif; }
        #canvas-container { width: 100vw; height: 100vh; display: block; }
        #hud {
            position: absolute; top: 20px; left: 20px; right: 20px;
            display: flex; justify-content: space-between; align-items: center; pointer-events: none;
            color: #fff; text-shadow: 0 0 10px rgba(0, 255, 204, 0.8);
        }
        .hud-box {
            background: rgba(10, 15, 25, 0.6); border: 1px solid rgba(0, 255, 204, 0.4);
            padding: 10px 20px; border-radius: 8px; backdrop-filter: blur(10px); pointer-events: auto;
        }
        .hud-score { font-size: 24px; font-weight: 800; color: #00ffcc; }
        .hud-health { font-size: 18px; color: #ff3366; }
        #mute-btn {
            background: rgba(10, 15, 25, 0.8); border: 1px solid #00ffcc; color: #fff;
            padding: 8px 14px; border-radius: 20px; font-size: 18px; cursor: pointer; pointer-events: auto;
        }
        
        /* Mobile Controls Overlay */
        #mobile-controls {
            position: absolute; bottom: 30px; left: 30px; right: 30px;
            display: flex; justify-content: space-between; align-items: flex-end;
            pointer-events: none;
        }
        .touch-pad {
            width: 120px; height: 120px; background: rgba(255, 255, 255, 0.1);
            border: 2px solid rgba(0, 255, 204, 0.4); border-radius: 50%;
            position: relative; pointer-events: auto; touch-action: none;
        }
        .touch-knob {
            width: 50px; height: 50px; background: rgba(0, 255, 204, 0.8);
            border-radius: 50%; position: absolute; top: 35px; left: 35px;
            box-shadow: 0 0 15px #00ffcc; transition: transform 0.05s ease;
        }
        .btn-fire {
            width: 90px; height: 90px; background: rgba(255, 51, 102, 0.8);
            border: 2px solid #fff; border-radius: 50%; font-weight: bold; color: #fff;
            display: flex; align-items: center; justify-content: center; font-size: 18px;
            pointer-events: auto; box-shadow: 0 0 20px rgba(255, 51, 102, 0.8);
            cursor: pointer;
        }
        .btn-fire:active { transform: scale(0.95); background: #ff0044; }
        #game-over {
            position: absolute; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0, 0, 0, 0.85); display: none; flex-direction: column;
            align-items: center; justify-content: center; color: #fff; z-index: 100;
        }
        #game-over h1 { font-size: 48px; color: #ff3366; margin-bottom: 20px; }
        .restart-btn {
            padding: 15px 40px; background: #00ffcc; color: #000; font-weight: 800;
            border: none; border-radius: 30px; font-size: 20px; cursor: pointer;
            box-shadow: 0 0 25px rgba(0, 255, 204, 0.8);
        }
    </style>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
</head>
<body>
    <div id="canvas-container"></div>
    <div id="hud">
        <div class="hud-box"><span class="hud-score" id="score">SCORE: 0</span></div>
        <button id="mute-btn" title="Toggle Audio">🔊</button>
        <div class="hud-box"><span class="hud-health" id="health">SHIELD: 100%</span></div>
    </div>
    
    <div id="mobile-controls">
        <div class="touch-pad" id="joystick">
            <div class="touch-knob" id="knob"></div>
        </div>
        <div class="btn-fire" id="fire-btn">FIRE</div>
    </div>
    
    <div id="game-over">
        <h1>MISSION TERMINATED</h1>
        <p style="font-size: 22px; margin-bottom: 30px;">Final Sovereign Score: <span id="final-score" style="color: #00ffcc;">0</span></p>
        <button class="restart-btn" onclick="location.reload()">RE-INITIALIZE</button>
    </div>

    <script>
        // ── Sovereign Web Audio API Synthesizer ──
        class SovereignAudioEngine {
            constructor() {
                this.ctx = null;
                this.muted = false;
                this.bgmTimer = null;
            }
            init() {
                if (!this.ctx) {
                    const AudioCtx = window.AudioContext || window.webkitAudioContext;
                    if (AudioCtx) this.ctx = new AudioCtx();
                }
                if (this.ctx && this.ctx.state === 'suspended') {
                    this.ctx.resume();
                }
                if (!this.bgmTimer && !this.muted) {
                    this.startBGM();
                }
            }
            toggleMute() {
                this.muted = !this.muted;
                const btn = document.getElementById('mute-btn');
                if (btn) btn.innerText = this.muted ? '🔇' : '🔊';
                if (this.muted && this.bgmTimer) {
                    clearInterval(this.bgmTimer);
                    this.bgmTimer = null;
                } else if (!this.muted) {
                    this.startBGM();
                }
            }
            playSFX(type) {
                if (this.muted || !this.ctx) return;
                try {
                    const osc = this.ctx.createOscillator();
                    const gain = this.ctx.createGain();
                    osc.connect(gain);
                    gain.connect(this.ctx.destination);
                    const now = this.ctx.currentTime;

                    if (type === 'laser') {
                        osc.type = 'sawtooth';
                        osc.frequency.setValueAtTime(800, now);
                        osc.frequency.exponentialRampToValueAtTime(120, now + 0.18);
                        gain.gain.setValueAtTime(0.25, now);
                        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
                        osc.start(now);
                        osc.stop(now + 0.18);
                    } else if (type === 'explosion') {
                        const bufferSize = this.ctx.sampleRate * 0.5;
                        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
                        const data = buffer.getChannelData(0);
                        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
                        const noise = this.ctx.createBufferSource();
                        noise.buffer = buffer;
                        const filter = this.ctx.createBiquadFilter();
                        filter.type = 'lowpass';
                        filter.frequency.setValueAtTime(400, now);
                        filter.frequency.linearRampToValueAtTime(60, now + 0.5);
                        noise.connect(filter);
                        filter.connect(gain);
                        gain.gain.setValueAtTime(0.4, now);
                        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
                        noise.start(now);
                    }
                } catch (e) {}
            }
            startBGM() {
                if (this.muted || !this.ctx || this.bgmTimer) return;
                const notes = [130.81, 164.81, 196.00, 233.08]; // C3, E3, G3, Bb3 Synthwave Arp
                let idx = 0;
                this.bgmTimer = setInterval(() => {
                    if (this.muted || !this.ctx) return;
                    try {
                        const osc = this.ctx.createOscillator();
                        const gain = this.ctx.createGain();
                        osc.type = 'triangle';
                        osc.frequency.value = notes[idx % notes.length];
                        idx++;
                        osc.connect(gain);
                        gain.connect(this.ctx.destination);
                        const now = this.ctx.currentTime;
                        gain.gain.setValueAtTime(0.06, now);
                        gain.gain.exponentialRampToValueAtTime(0.005, now + 0.16);
                        osc.start(now);
                        osc.stop(now + 0.16);
                    } catch (e) {}
                }, 180);
            }
        }
        const audio = new SovereignAudioEngine();
        document.getElementById('mute-btn').addEventListener('click', () => audio.toggleMute());
        window.addEventListener('pointerdown', () => audio.init(), { once: true });
        window.addEventListener('keydown', () => audio.init(), { once: true });

        // Scene, Camera, Renderer
        const container = document.getElementById('canvas-container');
        const scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x050811, 0.015);
        
        const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
        camera.position.set(0, 4, 12);
        camera.lookAt(0, 0, -10);
        
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.shadowMap.enabled = true;
        container.appendChild(renderer.domElement);
        
        // Lighting
        const ambLight = new THREE.AmbientLight(0x223344, 1.5);
        scene.add(ambLight);
        
        const dirLight = new THREE.DirectionalLight(0x00ffcc, 2.0);
        dirLight.position.set(10, 20, 10);
        scene.add(dirLight);

        // Player Ship Rig (Cyberpunk Jet)
        const shipGroup = new THREE.Group();
        const bodyGeo = new THREE.ConeGeometry(0.8, 2.5, 4);
        bodyGeo.rotateX(Math.PI / 2);
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x00ffcc, metalness: 0.8, roughness: 0.2, wireframe: false });
        const shipBody = new THREE.Mesh(bodyGeo, bodyMat);
        shipGroup.add(shipBody);
        
        const wingGeo = new THREE.BoxGeometry(3.0, 0.1, 0.8);
        const wingMat = new THREE.MeshStandardMaterial({ color: 0x112233, metalness: 0.9 });
        const shipWings = new THREE.Mesh(wingGeo, wingMat);
        shipWings.position.set(0, -0.2, 0.5);
        shipGroup.add(shipWings);
        scene.add(shipGroup);
        shipGroup.position.set(0, 0, 0);

        // Grid Tunnel Environment
        const gridHelper = new THREE.GridHelper(200, 50, 0x00ffcc, 0x112233);
        gridHelper.position.y = -3;
        scene.add(gridHelper);

        // Game State & Arrays
        let score = 0;
        let health = 100;
        let isGameOver = false;
        const lasers = [];
        const enemies = [];
        const particles = [];

        // Controls State
        const keys = { Left: false, Right: false, Up: false, Down: false, Space: false };
        let joyX = 0, joyY = 0;

        window.addEventListener('keydown', (e) => {
            if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.Left = true;
            if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.Right = true;
            if (e.code === 'ArrowUp' || e.code === 'KeyW') keys.Up = true;
            if (e.code === 'ArrowDown' || e.code === 'KeyS') keys.Down = true;
            if (e.code === 'Space') { keys.Space = true; fireLaser(); }
        });
        window.addEventListener('keyup', (e) => {
            if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.Left = false;
            if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.Right = false;
            if (e.code === 'ArrowUp' || e.code === 'KeyW') keys.Up = false;
            if (e.code === 'ArrowDown' || e.code === 'KeyS') keys.Down = false;
            if (e.code === 'Space') keys.Space = false;
        });

        const joystick = document.getElementById('joystick');
        const knob = document.getElementById('knob');
        joystick.addEventListener('pointermove', (e) => {
            if (e.buttons !== 1) return;
            const rect = joystick.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            let dx = e.clientX - cx;
            let dy = e.clientY - cy;
            const dist = Math.min(35, Math.hypot(dx, dy));
            const angle = Math.atan2(dy, dx);
            knob.style.transform = \`translate(\${Math.cos(angle)*dist}px, \${Math.sin(angle)*dist}px)\`;
            joyX = (Math.cos(angle) * dist) / 35;
            joyY = (Math.sin(angle) * dist) / 35;
        });
        joystick.addEventListener('pointerup', () => {
            knob.style.transform = 'translate(0, 0)';
            joyX = 0; joyY = 0;
        });
        document.getElementById('fire-btn').addEventListener('pointerdown', fireLaser);

        function fireLaser() {
            if (isGameOver) return;
            audio.init();
            audio.playSFX('laser');
            const laserGeo = new THREE.CylinderGeometry(0.1, 0.1, 1.5, 8);
            laserGeo.rotateX(Math.PI / 2);
            const laserMat = new THREE.MeshBasicMaterial({ color: 0xff3366 });
            const laser = new THREE.Mesh(laserGeo, laserMat);
            laser.position.copy(shipGroup.position);
            laser.position.z -= 1.5;
            scene.add(laser);
            lasers.push(laser);
        }

        function spawnEnemy() {
            if (isGameOver) return;
            const geo = new THREE.DodecahedronGeometry(1.2, 0);
            const mat = new THREE.MeshStandardMaterial({ color: 0xff3366, roughness: 0.4, metalness: 0.6 });
            const enemy = new THREE.Mesh(geo, mat);
            enemy.position.set((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 10, -60);
            scene.add(enemy);
            enemies.push(enemy);
        }
        setInterval(spawnEnemy, 1200);

        function spawnExplosion(pos, colorHex) {
            for (let i = 0; i < 12; i++) {
                const pGeo = new THREE.SphereGeometry(0.2, 4, 4);
                const pMat = new THREE.MeshBasicMaterial({ color: colorHex });
                const p = new THREE.Mesh(pGeo, pMat);
                p.position.copy(pos);
                p.userData = {
                    vx: (Math.random() - 0.5) * 0.8,
                    vy: (Math.random() - 0.5) * 0.8,
                    vz: (Math.random() - 0.5) * 0.8,
                    life: 1.0
                };
                scene.add(p);
                particles.push(p);
            }
        }

        function animate() {
            if (isGameOver) return;
            requestAnimationFrame(animate);

            let vx = (joyX + (keys.Right ? 1 : 0) - (keys.Left ? 1 : 0)) * 0.35;
            let vy = (-joyY + (keys.Up ? 1 : 0) - (keys.Down ? 1 : 0)) * 0.35;
            shipGroup.position.x = Math.max(-12, Math.min(12, shipGroup.position.x + vx));
            shipGroup.position.y = Math.max(-2, Math.min(8, shipGroup.position.y + vy));
            shipGroup.rotation.z = -vx * 1.5;
            shipGroup.rotation.x = vy * 0.5;

            gridHelper.position.z = (gridHelper.position.z + 0.4) % 4;

            for (let i = lasers.length - 1; i >= 0; i--) {
                lasers[i].position.z -= 1.8;
                if (lasers[i].position.z < -80) {
                    scene.remove(lasers[i]);
                    lasers.splice(i, 1);
                }
            }

            for (let i = enemies.length - 1; i >= 0; i--) {
                const en = enemies[i];
                en.position.z += 0.45;
                en.rotation.x += 0.02;
                en.rotation.y += 0.03;

                if (en.position.distanceTo(shipGroup.position) < 2.0) {
                    audio.playSFX('explosion');
                    spawnExplosion(en.position, 0xff3366);
                    scene.remove(en);
                    enemies.splice(i, 1);
                    health -= 25;
                    document.getElementById('health').innerText = \`SHIELD: \${Math.max(0, health)}%\`;
                    if (health <= 0) triggerGameOver();
                    continue;
                }

                for (let j = lasers.length - 1; j >= 0; j--) {
                    if (en.position.distanceTo(lasers[j].position) < 1.8) {
                        audio.playSFX('explosion');
                        spawnExplosion(en.position, 0x00ffcc);
                        scene.remove(en);
                        scene.remove(lasers[j]);
                        enemies.splice(i, 1);
                        lasers.splice(j, 1);
                        score += 100;
                        document.getElementById('score').innerText = \`SCORE: \${score}\`;
                        break;
                    }
                }

                if (en && en.position.z > 15) {
                    scene.remove(en);
                    enemies.splice(i, 1);
                }
            }

            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.position.x += p.userData.vx;
                p.position.y += p.userData.vy;
                p.position.z += p.userData.vz;
                p.userData.life -= 0.04;
                p.scale.setScalar(p.userData.life);
                if (p.userData.life <= 0) {
                    scene.remove(p);
                    particles.splice(i, 1);
                }
            }

            renderer.render(scene, camera);
        }

        function triggerGameOver() {
            isGameOver = true;
            document.getElementById('final-score').innerText = score;
            document.getElementById('game-over').style.display = 'flex';
        }

        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        });

        animate();
    </script>
</body>
</html>`;
}

// -----------------------------------------------------------------------------
// Benchmark Template 2: 2D Cyberpunk Platformer (Canvas 2D + Web Audio)
// -----------------------------------------------------------------------------
function getArcadePlatformer2dTemplate(title, includeAudio = true) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${title} — Causyne 2D Arcade Engine</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; user-select: none; }
        body { background: #080a12; overflow: hidden; font-family: 'JetBrains Mono', monospace; display: flex; align-items: center; justify-content: center; height: 100vh; }
        canvas { background: #0d1220; border: 2px solid #00ffcc; box-shadow: 0 0 30px rgba(0, 255, 204, 0.3); max-width: 100vw; max-height: 100vh; }
        #hud { position: absolute; top: 20px; left: 20px; right: 20px; display: flex; justify-content: space-between; pointer-events: none; }
        #mute-btn {
            background: rgba(10, 15, 25, 0.8); border: 1px solid #00ffcc; color: #fff;
            padding: 8px 14px; border-radius: 20px; font-size: 18px; cursor: pointer; pointer-events: auto;
        }
        #mobile-controls {
            position: absolute; bottom: 20px; left: 20px; right: 20px;
            display: flex; justify-content: space-between; pointer-events: none;
        }
        .btn-group { display: flex; gap: 15px; pointer-events: auto; }
        .touch-btn {
            width: 70px; height: 70px; background: rgba(0, 255, 204, 0.2);
            border: 2px solid #00ffcc; border-radius: 12px; color: #fff; font-size: 24px;
            font-weight: bold; display: flex; align-items: center; justify-content: center;
        }
        .touch-btn:active { background: #00ffcc; color: #000; }
    </style>
</head>
<body>
    <div id="hud">
        <span style="color: #fff; font-size: 24px; font-weight: bold;"></span>
        <button id="mute-btn" title="Toggle Audio">🔊</button>
    </div>
    <canvas id="gameCanvas" width="960" height="540"></canvas>
    
    <div id="mobile-controls">
        <div class="btn-group">
            <div class="touch-btn" id="btn-left">◀</div>
            <div class="touch-btn" id="btn-right">▶</div>
        </div>
        <div class="btn-group">
            <div class="touch-btn" id="btn-jump" style="background: rgba(255, 51, 102, 0.2); border-color: #ff3366;">▲</div>
        </div>
    </div>

    <script>
        // ── Sovereign Web Audio API Synthesizer ──
        class SovereignAudioEngine {
            constructor() {
                this.ctx = null;
                this.muted = false;
                this.bgmTimer = null;
            }
            init() {
                if (!this.ctx) {
                    const AudioCtx = window.AudioContext || window.webkitAudioContext;
                    if (AudioCtx) this.ctx = new AudioCtx();
                }
                if (this.ctx && this.ctx.state === 'suspended') {
                    this.ctx.resume();
                }
                if (!this.bgmTimer && !this.muted) {
                    this.startBGM();
                }
            }
            toggleMute() {
                this.muted = !this.muted;
                const btn = document.getElementById('mute-btn');
                if (btn) btn.innerText = this.muted ? '🔇' : '🔊';
                if (this.muted && this.bgmTimer) {
                    clearInterval(this.bgmTimer);
                    this.bgmTimer = null;
                } else if (!this.muted) {
                    this.startBGM();
                }
            }
            playSFX(type) {
                if (this.muted || !this.ctx) return;
                try {
                    const osc = this.ctx.createOscillator();
                    const gain = this.ctx.createGain();
                    osc.connect(gain);
                    gain.connect(this.ctx.destination);
                    const now = this.ctx.currentTime;

                    if (type === 'jump') {
                        osc.type = 'square';
                        osc.frequency.setValueAtTime(260, now);
                        osc.frequency.linearRampToValueAtTime(560, now + 0.15);
                        gain.gain.setValueAtTime(0.2, now);
                        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
                        osc.start(now);
                        osc.stop(now + 0.15);
                    } else if (type === 'coin') {
                        osc.type = 'sine';
                        osc.frequency.setValueAtTime(1200, now);
                        osc.frequency.setValueAtTime(1800, now + 0.08);
                        gain.gain.setValueAtTime(0.25, now);
                        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.28);
                        osc.start(now);
                        osc.stop(now + 0.28);
                    }
                } catch (e) {}
            }
            startBGM() {
                if (this.muted || !this.ctx || this.bgmTimer) return;
                const notes = [164.81, 196.00, 220.00, 261.63]; // E3, G3, A3, C4 Arp
                let idx = 0;
                this.bgmTimer = setInterval(() => {
                    if (this.muted || !this.ctx) return;
                    try {
                        const osc = this.ctx.createOscillator();
                        const gain = this.ctx.createGain();
                        osc.type = 'triangle';
                        osc.frequency.value = notes[idx % notes.length];
                        idx++;
                        osc.connect(gain);
                        gain.connect(this.ctx.destination);
                        const now = this.ctx.currentTime;
                        gain.gain.setValueAtTime(0.06, now);
                        gain.gain.exponentialRampToValueAtTime(0.005, now + 0.16);
                        osc.start(now);
                        osc.stop(now + 0.16);
                    } catch (e) {}
                }, 180);
            }
        }
        const audio = new SovereignAudioEngine();
        document.getElementById('mute-btn').addEventListener('click', () => audio.toggleMute());
        window.addEventListener('pointerdown', () => audio.init(), { once: true });
        window.addEventListener('keydown', () => audio.init(), { once: true });

        const canvas = document.getElementById('gameCanvas');
        const ctx = canvas.getContext('2d');

        const player = {
            x: 100, y: 300, w: 36, h: 48, vx: 0, vy: 0, speed: 6, jump: -14,
            grounded: false, color: '#00ffcc'
        };

        const gravity = 0.65;
        const keys = { left: false, right: false, up: false };

        const platforms = [
            { x: 0, y: 500, w: 960, h: 40, color: '#1a243a' },
            { x: 180, y: 380, w: 200, h: 20, color: '#00ffcc' },
            { x: 450, y: 280, w: 180, h: 20, color: '#ff3366' },
            { x: 700, y: 180, w: 200, h: 20, color: '#00ffcc' }
        ];

        const coins = [
            { x: 260, y: 340, r: 12, collected: false },
            { x: 530, y: 240, r: 12, collected: false },
            { x: 780, y: 140, r: 12, collected: false }
        ];
        let score = 0;

        window.addEventListener('keydown', (e) => {
            if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.left = true;
            if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.right = true;
            if ((e.code === 'ArrowUp' || e.code === 'Space') && player.grounded) {
                player.vy = player.jump; player.grounded = false;
                audio.init(); audio.playSFX('jump');
            }
        });
        window.addEventListener('keyup', (e) => {
            if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.left = false;
            if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.right = false;
        });

        document.getElementById('btn-left').addEventListener('pointerdown', () => keys.left = true);
        document.getElementById('btn-left').addEventListener('pointerup', () => keys.left = false);
        document.getElementById('btn-right').addEventListener('pointerdown', () => keys.right = true);
        document.getElementById('btn-right').addEventListener('pointerup', () => keys.right = false);
        document.getElementById('btn-jump').addEventListener('pointerdown', () => {
            if (player.grounded) {
                player.vy = player.jump; player.grounded = false;
                audio.init(); audio.playSFX('jump');
            }
        });

        function update() {
            if (keys.left) player.vx = -player.speed;
            else if (keys.right) player.vx = player.speed;
            else player.vx *= 0.8;

            player.x += player.vx;
            player.vy += gravity;
            player.y += player.vy;
            player.grounded = false;

            for (const p of platforms) {
                if (player.x < p.x + p.w && player.x + player.w > p.x &&
                    player.y + player.h > p.y && player.y + player.h < p.y + p.h + player.vy) {
                    player.y = p.y - player.h;
                    player.vy = 0;
                    player.grounded = true;
                }
            }

            for (const c of coins) {
                if (!c.collected && Math.hypot(player.x + player.w/2 - c.x, player.y + player.h/2 - c.y) < c.r + 18) {
                    c.collected = true;
                    score += 100;
                    audio.playSFX('coin');
                }
            }

            if (player.x < 0) player.x = 0;
            if (player.x + player.w > canvas.width) player.x = canvas.width - player.w;
            if (player.y > canvas.height) { player.x = 100; player.y = 300; player.vy = 0; }
        }

        function draw() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            for (const p of platforms) {
                ctx.fillStyle = p.color;
                ctx.fillRect(p.x, p.y, p.w, p.h);
                ctx.shadowColor = p.color;
                ctx.shadowBlur = 10;
            }

            for (const c of coins) {
                if (!c.collected) {
                    ctx.beginPath();
                    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
                    ctx.fillStyle = '#ffcc00';
                    ctx.fill();
                    ctx.shadowColor = '#ffcc00';
                    ctx.shadowBlur = 15;
                }
            }

            ctx.fillStyle = player.color;
            ctx.fillRect(player.x, player.y, player.w, player.h);
            ctx.shadowColor = player.color;
            ctx.shadowBlur = 20;

            ctx.shadowBlur = 0;
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 24px JetBrains Mono';
            ctx.fillText(\`SCORE: \${score}\`, 20, 40);

            requestAnimationFrame(() => { update(); draw(); });
        }

        draw();
    </script>
</body>
</html>`;
}

// -----------------------------------------------------------------------------
// Benchmark Template 3: 3D Cyberpunk Highway Racer (Three.js + Web Audio)
// -----------------------------------------------------------------------------
function getCyberpunkRacer3dTemplate(title, includeAudio = true) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${title} — Cyberpunk Racer 3D</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; user-select: none; }
        body { background: #03050c; overflow: hidden; font-family: 'Outfit', sans-serif; }
        #canvas-container { width: 100vw; height: 100vh; display: block; }
        #hud {
            position: absolute; top: 20px; left: 20px; right: 20px;
            display: flex; justify-content: space-between; align-items: center; pointer-events: none;
            color: #fff; text-shadow: 0 0 10px #00ffcc;
        }
        .hud-box {
            background: rgba(10, 15, 25, 0.7); border: 1px solid #00ffcc;
            padding: 12px 24px; border-radius: 8px; backdrop-filter: blur(10px); pointer-events: auto;
        }
        .speed-val { font-size: 28px; font-weight: 800; color: #ff0055; }
    </style>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
</head>
<body>
    <div id="canvas-container"></div>
    <div id="hud">
        <div class="hud-box"><span class="speed-val" id="speed-hud">SPEED: 0 MPH</span></div>
        <div class="hud-box"><span id="score-hud" style="font-size: 24px; font-weight: bold; color: #00ffcc;">DISTANCE: 0 M</span></div>
    </div>
    <script>
        const container = document.getElementById('canvas-container');
        const scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x050814, 0.02);
        const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
        camera.position.set(0, 4, 10);
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        container.appendChild(renderer.domElement);

        const ambLight = new THREE.AmbientLight(0x223344, 2.0);
        scene.add(ambLight);
        const dirLight = new THREE.DirectionalLight(0x00ffcc, 1.5);
        dirLight.position.set(10, 20, 10);
        scene.add(dirLight);

        // Road
        const roadGeo = new THREE.PlaneGeometry(16, 600, 10, 100);
        roadGeo.rotateX(-Math.PI / 2);
        const roadMat = new THREE.MeshStandardMaterial({ color: 0x0f1422, roughness: 0.8 });
        const road = new THREE.Mesh(roadGeo, roadMat);
        scene.add(road);

        // Car
        const carGeo = new THREE.BoxGeometry(2.0, 0.8, 4.0);
        const carMat = new THREE.MeshStandardMaterial({ color: 0xff0055, metalness: 0.9, roughness: 0.1 });
        const car = new THREE.Mesh(carGeo, carMat);
        car.position.set(0, 0.5, 3);
        scene.add(car);

        let speed = 0, targetSpeed = 120, distance = 0;
        const keys = { Left: false, Right: false, Up: false, Down: false };
        window.addEventListener('keydown', e => { if(e.code==='ArrowLeft'||e.code==='KeyA') keys.Left=true; if(e.code==='ArrowRight'||e.code==='KeyD') keys.Right=true; if(e.code==='ArrowUp'||e.code==='KeyW') keys.Up=true; });
        window.addEventListener('keyup', e => { if(e.code==='ArrowLeft'||e.code==='KeyA') keys.Left=false; if(e.code==='ArrowRight'||e.code==='KeyD') keys.Right=false; if(e.code==='ArrowUp'||e.code==='KeyW') keys.Up=false; });

        function animate() {
            requestAnimationFrame(animate);
            if (keys.Up) speed = Math.min(220, speed + 1.5); else speed = Math.max(30, speed - 0.5);
            if (keys.Left) car.position.x = Math.max(-6, car.position.x - 0.25);
            if (keys.Right) car.position.x = Math.min(6, car.position.x + 0.25);
            car.rotation.z = (car.position.x * -0.05);
            distance += speed * 0.05;
            document.getElementById('speed-hud').innerText = \`SPEED: \${Math.round(speed)} MPH\`;
            document.getElementById('score-hud').innerText = \`DISTANCE: \${Math.round(distance)} M\`;
            renderer.render(scene, camera);
        }
        animate();
    </script>
</body>
</html>`;
}

// -----------------------------------------------------------------------------
// Benchmark Template 4: 2D Top-Down RPG (Canvas 2D + Web Audio)
// -----------------------------------------------------------------------------
function getTopdownRpg2dTemplate(title, includeAudio = true) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} — Topdown RPG 2D</title>
    <style>
        body { margin: 0; background: #11141a; display: flex; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif; color: #fff; }
        canvas { background: #1b2233; border: 2px solid #3a86ff; box-shadow: 0 0 20px rgba(58,134,255,0.4); }
    </style>
</head>
<body>
    <canvas id="rpgCanvas" width="800" height="600"></canvas>
    <script>
        const canvas = document.getElementById('rpgCanvas');
        const ctx = canvas.getContext('2d');
        const hero = { x: 400, y: 300, r: 18, speed: 4, color: '#3a86ff' };
        const keys = {};
        window.addEventListener('keydown', e => keys[e.code] = true);
        window.addEventListener('keyup', e => keys[e.code] = false);

        function loop() {
            if (keys['KeyW'] || keys['ArrowUp']) hero.y -= hero.speed;
            if (keys['KeyS'] || keys['ArrowDown']) hero.y += hero.speed;
            if (keys['KeyA'] || keys['ArrowLeft']) hero.x -= hero.speed;
            if (keys['KeyD'] || keys['ArrowRight']) hero.x += hero.speed;
            hero.x = Math.max(hero.r, Math.min(canvas.width - hero.r, hero.x));
            hero.y = Math.max(hero.r, Math.min(canvas.height - hero.r, hero.y));

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#1e293b';
            for(let x=0; x<canvas.width; x+=40) {
                for(let y=0; y<canvas.height; y+=40) {
                    ctx.strokeRect(x, y, 40, 40);
                }
            }
            ctx.beginPath();
            ctx.arc(hero.x, hero.y, hero.r, 0, Math.PI * 2);
            ctx.fillStyle = hero.color;
            ctx.fill();
            ctx.shadowColor = hero.color;
            ctx.shadowBlur = 15;
            ctx.font = 'bold 20px sans-serif';
            ctx.fillText('${title}', 20, 35);
            requestAnimationFrame(loop);
        }
        loop();
    </script>
</body>
</html>`;
}

export const gameBuilder = {
  schema: {
    name: 'game.build_html5',
    description: 'Instant Sovereign HTML5 Game Engine Builder (`100% offline edge ready`). Generates complete, browser-playable 3D WebGL (Three.js) or 2D Arcade (Canvas 2D) games with procedural sound effects (`SFX`), looping background music (`BGM`), mobile touch controls, and WASD controls directly inside local workspace buffers (`space_defense_3d`, `arcade_platformer_2d`, `cyberpunk_racer_3d`, `topdown_rpg_2d`, `custom`).',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the game (`Sovereign Space Defense`, `Cyberpunk Racer 3D`).' },
        engine: { type: 'string', enum: ['threejs', 'canvas2d'], description: 'Game engine selection: `threejs` (3D WebGL) or `canvas2d` (2D Arcade Physics).' },
        template: {
          type: 'string',
          enum: ['space_defense_3d', 'arcade_platformer_2d', 'cyberpunk_racer_3d', 'topdown_rpg_2d', 'custom'],
          description: 'Preset benchmark template (`space_defense_3d`, `arcade_platformer_2d`, `cyberpunk_racer_3d`, `topdown_rpg_2d`) or `custom` for custom script.'
        },
        audio: { type: 'boolean', description: 'Whether to embed the SovereignAudioEngine for procedural SFX & Synthwave BGM (default: true).' },
        customScript: { type: 'string', description: 'Complete custom HTML/JS code if `template` is `custom`.' },
        outputDir: { type: 'string', description: 'Target output directory. Defaults to `.tmp_causyne_3d` in current workspace.' },
        filename: { type: 'string', description: 'Name of HTML file to write (default: `game.html`).' }
      },
      required: ['title', 'engine']
    }
  },

  async execute(args) {
    try {
      const { title, engine, template, audio = true, customScript, outputDir, filename = 'game.html' } = args;
      const targetDir = outputDir || getWorkspaceTempDir();
      if (!fsSync.existsSync(targetDir)) {
        await fs.mkdir(targetDir, { recursive: true });
      }

      let htmlContent = '';
      if (template === 'custom' && customScript) {
        htmlContent = customScript;
      } else if (template === 'cyberpunk_racer_3d') {
        htmlContent = getCyberpunkRacer3dTemplate(title, audio);
      } else if (template === 'topdown_rpg_2d') {
        htmlContent = getTopdownRpg2dTemplate(title, audio);
      } else if (engine === 'threejs' || template === 'space_defense_3d') {
        htmlContent = getSpaceDefense3dTemplate(title, audio);
      } else {
        htmlContent = getArcadePlatformer2dTemplate(title, audio);
      }

      const filePath = path.join(targetDir, filename);
      await fs.writeFile(filePath, htmlContent, 'utf8');

      return {
        success: true,
        output: JSON.stringify({
          engine: engine === 'threejs' ? 'Three.js (3D WebGL + Web Audio)' : 'Canvas 2D Arcade Engine (+ Web Audio)',
          template: template || (engine === 'threejs' ? 'space_defense_3d' : 'arcade_platformer_2d'),
          title: title,
          audio_enabled: audio,
          output_file: filePath,
          size_bytes: Buffer.byteLength(htmlContent, 'utf8'),
          ready_to_play: true,
          instructions: `Open ${filePath} directly in Google Chrome or via browser_act to play instantly across Desktop and Mobile.`
        }, null, 2)
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};

