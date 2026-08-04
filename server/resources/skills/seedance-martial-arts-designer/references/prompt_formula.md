# Seedance Prompt Formula

## Five-Part Structure

Every Seedance martial arts prompt must follow this structure, in order:

```
[Environment] + [Action Choreography] + [Camera Language] + [Atmosphere/Particles] + [Quality Statement]
```

## Part 1: Environment (环境描写)

Establish the spatial setting in 2-3 sentences. Cover:
- **Location**: Specific place with depth cues (foreground/midground/background)
- **Lighting**: Light source, color temperature, direction
- **Atmosphere**: Weather, mist, smoke, time of day
- **Depth**: At least 3 layers (near foreground objects, main action zone, distant background)

Example (Chinese):
> 清晨薄雾笼罩的竹林，阳光透过竹叶缝隙洒下斑驳光斑。翠绿竹竿密密排列，微风摇曳。地面铺满落叶与晨露。远景可见山峦叠嶂隐于雾中。

Example (English):
> Misty bamboo forest at dawn, dappled sunlight through green bamboo leaves, morning dew on the ground. A single bare tree in the distance, minimalist composition with generous negative space.

Key patterns:
- Always specify light source direction and quality (dappled, harsh, soft, neon)
- Include at least one background element for depth
- Mention atmosphere particles (mist, rain, snow, smoke, dust)

## Part 2: Action Choreography (动作编排)

Describe character actions in strict chronological order. Rules:
- Use specific martial arts move names (see choreography_guide.md for catalog)
- Specify body posture for every action (forward lean, side turn, spin, crouch)
- Chain cause -> effect for every action (kick -> bowl flies, slash -> snow cracks)
- Number multiple exchanges explicitly ("three strikes", "two dodges")
- Mark rhythm changes ("slow motion", "rapid exchange", "freeze frame")

Example (Chinese):
> 主角脚尖轻点竹梢跃出，身体前倾飞行，衣袂飘扬；追击者单手推开竹竿，竹竿弯折弹回卷起落叶旋飞。主角空中转身甩袖射出暗器，暗器穿林而过；追击者侧身闪避借竹竿弹力加速前冲。

Example (English):
> The protagonist springs off bamboo tips in a forward-leaning flight, robes billowing; the pursuer pushes aside bamboo stalks that bend and snap back, swirling fallen leaves. The protagonist spins mid-air, flicking hidden projectiles from his sleeve.

## Part 3: Camera Language (镜头语言)

Describe shot type, movement, and transitions. Use the camera keyword mapping in camera_language.md.

Example (Chinese):
> 跟拍镜头，中景到全景切换，慢动作特写暗器飞行轨迹，最后环绕镜头拍摄两人落竹对峙拔剑。

Example (English):
> Tracking shot transitioning from medium to wide, slow-motion close-up of projectile trajectories, ending with an orbiting shot as both land on the same bamboo stalk and draw swords.

## Part 4: Atmosphere/Particles (氛围效果)

Specify visual particle effects and color tone:
- **Particles**: leaves swirling, water spray, snow drifting, porcelain shattering, incense ash, dust clouds
- **Color tone**: warm yellow, cold blue, grey-white, vermillion red
- **Mood word**: ethereal, lethal, rustic, desolate, solemn

Example:
> 竹叶纷飞，光影斑驳，画面空灵飘逸 / Leaves swirling, dappled light, ethereal atmosphere

## Part 5: Quality Statement (画质声明)

Always end with:
- Chinese: 电影级画质
- English: cinematic quality

## Semantic Span Marking

When writing prompts for the HTML output, wrap sections in semantic spans for visual color-coding:

```html
<span class="env">环境描写内容...</span>
<span class="act">动作编排内容...</span>
<span class="cam">镜头语言内容...</span>
```

CSS classes:
- `.env` -> teal/green color
- `.act` -> coral/orange color
- `.cam` -> blue color

## Complete Annotated Example

**Chinese:**
> [env]暴雨倾盆的城市屋顶夜晚，霓虹灯光透过雨幕映射蓝紫色调，地面积水倒影闪烁，远处高楼轮廓朦胧，闪电照亮天际。[/env] [act]闪电瞬间两人高速冲向对方，脚下溅起巨大水花；右拳与刀鞘在空中碰撞，冲击波震开雨水形成环形水幕。快速交手三招——格挡、反击、侧踢，每拳带起雨水飞溅。[/act] [cam]低角度正面拍摄冲锋，特写慢动作捕捉碰撞冲击，中景快速剪辑三招交锋，侧面跟拍翻越动作，最后慢动作侧面特写错身定格。[/cam] 雨水粒子效果丰富，霓虹反光，冷色调画面，凌厉肃杀，电影级画质。

**English:**
> [env]Torrential rain on a city rooftop at night, neon lights filtering through rain creating blue-purple tones, puddle reflections flickering, distant skyscrapers shrouded, lightning illuminating the skyline.[/env] [act]Lightning flashes as both charge at high speed, kicking up massive water spray; fist meets blade sheath mid-air, the impact shockwave disperses rain into a ring of water. Rapid exchange of three strikes—block, counter, side kick—each blow sending rain flying.[/act] [cam]Low-angle frontal shot of the charge, close-up slow-motion of impact, medium-shot rapid cuts for the three-strike exchange, side tracking of the flip, final slow-motion side close-up of the passing freeze.[/cam] Rich rain particle effects, neon reflections, cold color palette, sharp and deadly atmosphere, cinematic quality.
