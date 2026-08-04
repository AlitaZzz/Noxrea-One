# Common Problems and Solutions

## Problem 1: Blurred/Indistinct Actions

**Symptom**: Generated video shows vague "fighting" without clear moves.
**Cause**: Prompt uses generic terms like "fight", "combat", "打斗" without specific moves.
**Solution**:
- Replace generic terms with specific martial arts moves (see choreography_guide.md catalog)
- Specify body posture for every action
- Add cause-effect chain: every action has a visible result
- Use numbered exchanges: "three strikes" not "they fight"

## Problem 2: Flat/Lack of Depth

**Symptom**: Scene looks like a 2D backdrop without spatial depth.
**Cause**: Environment description lacks layered elements.
**Solution**:
- Add 3 depth layers: foreground objects, midground action zone, background scenery
- Include depth cues: "foreground bamboo leaves blurred", "distant mountains shrouded in mist"
- Use camera language that implies depth: "push in from wide to close-up"

## Problem 3: Missing Particle Effects

**Symptom**: Scene feels static, lacks environmental dynamism.
**Cause**: No particle effects specified in prompt.
**Solution**:
- Match particles to environment: bamboo->leaves, rain->water spray, snow->snow particles, tavern->shards
- Tie particles to actions: "kick sends leaves swirling", "slash creates snow mist"
- Specify particle behavior: "swirling", "exploding", "drifting", "cascading"

## Problem 4: Poor Rhythm/Pacing

**Symptom**: Entire video feels uniformly paced, no dramatic peaks.
**Cause**: No rhythm variation specified in prompt.
**Solution**:
- Explicitly mark rhythm changes: "slow motion", "rapid exchange", "freeze frame"
- Use the rhythm patterns from choreography_guide.md
- Place slow-motion at impact moments (beat 2-3)
- End with freeze frame (beat 5)

## Problem 5: Wrong Color Tone

**Symptom**: Generated scene has unexpected color palette.
**Cause**: Color tone description is vague or missing.
**Solution**:
- Specify color temperature explicitly: "warm yellow candlelight" not just "warm"
- Reference a specific color pair: "cold blue + neon purple"
- Include a reference film: "color palette similar to Hero (英雄)"
- Use the style color palette table from SKILL.md

## Problem 6: Multi-Character Confusion

**Symptom**: AI confuses which character is performing which action.
**Cause**: Characters not clearly labeled.
**Solution**:
- Use distinct role labels: "protagonist/主角", "pursuer/追击者", "thug A/歹徒甲"
- Describe each character's appearance briefly when introduced: "white-robed swordsman", "black-clad assassin"
- Keep actions sequential, not simultaneous, when possible
- For simultaneous actions, clearly attribute: "while A does X, B does Y"

## Problem 7: Unrealistic Body Posture

**Symptom**: Characters appear standing/running when they should be leaping/flying.
**Cause**: Body posture not specified for aerial/acrobatic moves.
**Solution**:
- Always specify posture: "forward-leaning flight", "mid-air spin", "crouching dodge"
- For aerial moves, specify launch and landing: "springs off surface, airborne, tip-toe landing"
- Describe the body's relationship to gravity: "horizontal flight", "upside-down rotation"

## Problem 8: Weapon Inconsistency

**Symptom**: Weapon changes appearance or disappears mid-scene.
**Cause**: Weapon not consistently referenced.
**Solution**:
- Name the weapon in every beat it appears: "long sword", "twin blades"
- Describe weapon-state changes: "draws sword", "sheathes blade", "sword tip touches ground"
- For thrown/fired weapons, track their path: "projectile slices through bamboo"

## Problem 9: Environment Doesn't React

**Symptom**: Environment feels static despite action occurring.
**Cause**: No environmental reaction specified.
**Solution**:
- Every action must have an environmental response (see cause-effect chain in choreography_guide.md)
- Specify what breaks, moves, or changes: "pillar shatters", "candles extinguish", "snow cracks"
- Include sound-implied visuals: "impact creates shockwave ring", "blade leaves arc trail"

## Problem 10: Weak Ending

**Symptom**: Video ends abruptly without visual resolution.
**Cause**: No freeze frame or settling action specified.
**Solution**:
- Always end beat 5 with "freeze frame" (定格)
- Include a settling action: "debris settles", "mist dissipates", "snowflakes fall"
- Create a final composition: "character stands amidst destruction", "lone figure in vast landscape"
