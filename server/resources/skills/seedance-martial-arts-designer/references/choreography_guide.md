# Action Choreography Guide

## Design Principles

### 1. Cause-Effect Chain
Every action MUST produce a visible environmental reaction:
- Kick -> object flies/breaks
- Slash -> surface cracks/cuts
- Punch -> shockwave/impact effect
- Dodge -> displacement of surrounding particles
- Landing -> ground crack/dust/depression

### 2. Body Posture Specification
Never use vague "fighting" or "combat". Always specify:
- Body angle: forward lean, backward lean, side turn, spin, crouch
- Limb position: arm extended, leg swept, fist chambered
- Movement direction: charging, retreating, circling, leaping

### 3. Rhythm Architecture
5-second scenes should follow one of these rhythm patterns:

| Pattern | Beat 1 | Beat 2 | Beat 3 | Beat 4 | Beat 5 |
|---------|--------|--------|--------|--------|--------|
| Build-up | Slow | Slow | Fast | Fast | Freeze |
| Explosive | Fast | Fast | Slow-mo | Fast | Freeze |
| Dance-like | Med | Med | Med | Climax | Settle |
| Chase | Fast | Faster | Slow-mo | Fast | Freeze |

### 4. Particle Effect Per Beat
Each beat must have at least one particle effect tied to the action:

| Environment | Particle Effects |
|-------------|-----------------|
| Bamboo forest | Leaves, bamboo fragments, dew drops |
| Rainy rooftop | Water spray, rain rings, splash |
| Tavern | Porcelain shards, wine liquid, wood splinters |
| Snowfield | Snow particles, snow mist, ice cracks |
| Temple | Incense ash, candle flames, dust clouds, wood debris |

## Martial Arts Move Catalog

### Sword (剑/刀)
- 上撩 (upward slash) - blade rises from low to high
- 横斩 (horizontal cut) - blade sweeps sideways
- 劈斩 (overhead strike) - blade descends from above
- 刺 (thrust) - blade extends forward
- 挑 (flick) - wrist snap sends blade tip up
- 格挡 (parry) - blade meets incoming attack
- 回旋 (spinning slash) - body rotates with extended blade
- 收剑入鞘 (sheathe) - blade returns to scabbard

### Unarmed (拳/腿)
- 罗汉拳 (Arhat fist) - powerful straight combinations
- 侧踢 (side kick) - leg extends laterally
- 飞脚 (flying kick) - kick delivered mid-air
- 后翻 (backflip) - backward rotation
- 前滚 (forward roll) - forward tuck and roll
- 肘击 (elbow strike) - close-range impact
- 扫堂腿 (sweep) - low leg sweep
- 掌击 (palm strike) - open-hand push with force

### Acrobatics/Aerial (轻功)
- 跃出 (spring out) - launch from surface
- 腾空 (leap) - airborne without surface contact
- 飞行 (flight) - sustained horizontal air movement
- 点地 (tip-toe landing) - brief surface contact mid-movement
- 俯冲 (dive) - downward aerial attack
- 空翻 (aerial flip) - rotation in air

### Hidden Weapons (暗器)
- 甩袖 (sleeve flick) - projectiles launched from sleeve
- 掷 (throw) - object thrown at target
- 射 (shoot) - projectile travels through space
- 弹 (flick) - small object launched with finger

### Defensive (防御)
- 侧身闪避 (side dodge) - body shifts laterally
- 后撤 (retreat) - backward movement
- 格挡 (block) - intercept incoming attack
- 借力 (rebound) - use opponent/object force to accelerate
- 化解 (redirect) - guide attack force away

## Choreography Table Format

Output the choreography as a table:

| Time | Action | Camera |
|------|--------|--------|
| 0.0-1.0s | [Character] [posture] [move], [cause] -> [visual effect] | [Shot type] |
| 1.0-2.0s | ... | ... |
| 2.0-3.0s | ... | ... |
| 3.0-4.0s | ... | ... |
| 4.0-5.0s | ... | [Shot type]定格 |

## Example Choreography (Tavern Brawl)

| Time | Action | Camera |
|------|--------|--------|
| 0.0-1.0s | Hero seated drinking, thugs surround. Kicks table over, wine bowls spin airborne | Orbiting medium, one-take |
| 1.0-2.0s | Grabs flying bowl, hurls at left thug's face, side-dodges bench from right | Tracking, medium |
| 2.0-3.0s | Sweeps long bench horizontally, repels two thugs, porcelain shatters | Low-angle upward, wide |
| 3.0-4.0s | Last thug throws wine jar, hero flying-kick shatters it, liquid explodes like rain | Slow-motion, close-up |
| 4.0-5.0s | Hero returns to seat, drinks last bowl, thugs collapse behind, debris settles | Frontal, medium freeze |

## Tips

- For group fights (1 vs many), always use role labels: "hero/侠客", "thug A/歹徒甲", "pursuer/追击者"
- For weapon fights, name the weapon in every beat it appears
- For solo performances (sword dance), emphasize the relationship between body movement and environmental particles
- The final beat should always end with a "freeze frame" (定格) for visual impact
