---
name: seedance-martial-arts-designer
description: Design martial arts action scenes for Seedance AI video generation. This skill should be used when the user asks to design, create, or choreograph martial arts / fight / combat / action scenes for video generation (especially Seedance). Triggers include phrases like "design a fight scene", "choreograph combat", "martial arts scene", "action sequence", "Seedance scene", or when the user provides character, weapon, and scene information and expects a fight choreography output.
---

# Seedance Martial Arts Designer

## Overview

This skill designs complete martial arts action scenes optimized for Seedance AI video generation. Given character descriptions, setting, weapons, and style preferences, produce a full scene design package: action choreography, Seedance prompts (Chinese + English), camera work, generation parameters, and tips.

## Workflow

### Step 1: Collect Inputs

Gather the following from the user. If any are missing, make reasonable inferences based on style/setting and note the assumptions. Do NOT block on questions unless critical information is absent.

| Input | Required | Example |
|-------|----------|---------|
| Character(s) | Yes | "白发剑客，白衣，孤傲" / "两名忍者" |
| Scene/Setting | Yes | "竹林" / "雨夜屋顶" / "酒馆" |
| Weapon(s) | Yes | "长剑" / "双刀" / "徒手" |
| Style preference | No | "古典武侠" / "现代动作" / "诗意" |
| Duration | No | Default 5s |
| Mood/Emotion | No | Infer from setting and style |
| Reference film | No | "《卧虎藏龙》竹林戏" |

### Step 2: Design Action Choreography

Design a 5-second action sequence broken into 5 one-second beats. Follow the choreography methodology in `references/choreography_guide.md`.

Core principles:
- Each beat has exactly ONE primary action with a clear cause-effect chain (action -> visual result)
- Use specific martial arts terminology (see move catalog in choreography guide)
- Specify body posture explicitly (forward lean, side turn, spin, etc.)
- Build rhythm: fast-slow-fast or slow-build-climax
- Every action must connect to a visual particle effect (leaves, water, snow, debris, etc.)

Output format: a choreography table with columns: Time | Action | Camera.

### Step 3: Write Seedance Prompts

Write prompts using the **five-part formula** (detailed in `references/prompt_formula.md`):

1. **Environment** (环境描写) - Establish space, lighting, atmosphere, depth
2. **Action** (动作编排) - Character + specific moves + cause-effect chain
3. **Camera** (镜头语言) - Shot type, movement, angle, transitions
4. **Atmosphere/Particles** (氛围效果) - Particle effects, color tone, mood
5. **Quality** (画质声明) - "cinematic quality" / "电影级画质"

Write BOTH Chinese and English versions. Mark sections with semantic spans for readability:
- Environment in teal/green tone
- Action in coral/orange tone
- Camera in blue tone

### Step 4: Design Camera Work

Create a 4-segment shot list. Reference `references/camera_language.md` for shot types and movements.

Each shot segment includes:
- Time range
- Description of what's filmed
- Camera movement (tracking, orbiting, handheld, etc.)
- Focal length / frame rate / angle notes

### Step 5: Recommend Parameters

| Parameter | Options | Default |
|-----------|---------|---------|
| Resolution | 720p, 1080p | 1080p |
| Frame rate | 24fps, 30fps | 30fps (24fps for poetic/dramatic) |
| Duration | 5s, 10s | 5s |
| Aspect ratio | 16:9, 21:9, 2.35:1 | 16:9 (21:9 for modern action, 2.35:1 for epic/poetic) |

### Step 6: Generate Tips

Provide 3-4 scene-specific generation tips covering:
- Key visual element to emphasize
- Common pitfall to avoid
- Parameter choice rationale
- Prompt engineering technique

Key template sections to fill:
- `{{SCENE_TITLE}}` / `{{SCENE_TITLE_EN}}` - Scene name
- `{{SCENE_NUM}}` - Scene number (01, 02, etc.)
- `{{SCENE_COLOR}}` - Accent color hex (see color palette in prompt_formula.md)
- Info grid: style, duration, mood, reference
- Scene setting paragraph
- Choreography table rows
- Chinese prompt text (with semantic spans)
- English prompt text (with semantic spans)
- Shot list items
- Parameter values
- Tips list

Save the output HTML to the workspace directory.

## Quick Reference: Style Color Palette

| Style | Primary | Accent | Mood |
|-------|---------|--------|------|
| Bamboo/Forest | #1D9E75 | #5DCAA5 | Ethereal, agile |
| Rainy/Night | #378ADD | #85B7EB | Cold, lethal |
| Tavern/Indoor | #EF9F27 | #FAC775 | Warm, rustic |
| Snow/Wasteland | #7F77DD | #AFA9EC | Desolate, poetic |
| Temple/Epic | #D85A30 | #F0997B | Solemn, grand |

## References

- `references/prompt_formula.md` - Five-part Seedance prompt structure with annotated examples
- `references/choreography_guide.md` - Action design methodology, martial arts move catalog, rhythm patterns
- `references/camera_language.md` - Camera shot types, movements, angles with Seedance keyword mapping
- `references/common_problems.md` - Common generation issues and solutions
