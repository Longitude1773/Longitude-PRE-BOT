# Park City STR Market Knowledge

Reference data driving STR projections. Structure is parser-defined: section headers, table formats, marker tags (`[ANCHOR]`, `[DERIVED from <anchor>]`), and `Key:` lines must stay exactly as shown. Content inside sections is human-authored.

## Seasonality

| Season | Months | Demand | Notes |
|---|---|---|---|
| Ski Peak | Dec-Mar | Highest | Deer Valley/PCMR ski season. Christmas-New Year and Presidents Day are premium weeks. |
| Summer | Jun-Aug | Secondary peak | Hiking, biking, concerts, festivals. Steady demand but lower ADR than ski. |
| Shoulder | Apr-May | Low | Mud season. Resorts closed, trails not yet open. Lowest occupancy of the year. |
| Fall Shoulder | Sep-Nov | Low-Medium | Leaf season has some demand. Sundance Film Festival prep in late Jan boosts early bookings. Nov picks up for Thanksgiving and early ski. |

ADR seasonality multipliers (applied to ski-peak baseline):
- Summer: 0.75-0.85x
- Fall shoulder: 0.65-0.75x
- Spring shoulder: 0.55-0.70x

## Luxury Tier Definitions

**Note for editors:** Changes to `Price ceiling` or `PPSF ceiling` values reclassify properties between tiers and will shift downstream revenue projections. Document the rationale for any threshold change in the commit message. Examples below remain as documentation for human readers; they are not classification signals.

Classification rule: tier = highest tier whose price OR PPSF threshold has been exceeded. Tier 4 = anything that exceeds Tier 3 on either dimension.

### Tier 1 — Standard
Clean, functional homes that meet baseline traveler expectations. Modest finishes, builder-grade materials, simple furnishings, and a focus on value and convenience over polish. Floor plans are utilitarian; design and layout are not differentiators.
Price ceiling: $1,000,000
PPSF ceiling: $400
Examples:
- 1-2BR condo in Kimball Junction, builder-grade finishes, sleeps 4-6, on a bus route to the resort.
- 3BR single-family in Heber Town Center, mid-90s build, simple modernized kitchen, walking distance to Main Street.
- Studio or 1BR in Old Town with basic furnishings, walk to Main Street, small unit in an older multi-family building.
- 3BR townhome in Kamas/Oakley with functional layout, neutral finishes, family-friendly but unbranded design.

### Tier 2 — Premium
Well-built and professionally maintained homes with elevated furnishings and updated finishes. Thoughtful design choices, intentional furniture selection, and stronger attention to layout and overall quality of feel. The property reads as cared for and intentional, not generic.
Price ceiling: $2,500,000
PPSF ceiling: $700
Examples:
- 3BR mountain-modern condo in Lower Deer Valley, professionally furnished, well-coordinated palette, hot tub access via HOA.
- 4BR single-family in North Fields, recently remodeled with quartz counters and shaker cabinets, intentional furniture rather than IKEA-grade.
- 2BR loft above Old Town/Main Street with designer touches, exposed beams, locally-sourced art on the walls.
- 4BR home in Pinebrook/Jeremy Ranch/Summit Park, well-maintained, updated kitchen and bathrooms, professional staging.

### Tier 3 — Luxury
High-end homes with exceptional design, premium materials, and sophisticated execution. Spaciousness, aesthetic coherence, and an emphasis on quality at every level. Often in desirable locations within the sub-market, with finish quality and design that consistently exceed expectations for the area.
Price ceiling: $5,000,000
PPSF ceiling: $1,200
Examples:
- 5BR single-family in Upper Deer Valley with exceptional design coherence, high-end millwork, premium appliances throughout, in a desirable corner of the sub-market.
- 4BR condo in Canyons Village with mountain-modern luxury finishes, slope-side or near-slope location, polished concrete, designer lighting.
- 6BR home in Jordanelle with expansive great room, premium materials, lake views, professionally curated interior.
- Penthouse condo in Deer Valley East Village, custom finishes, multiple master suites, elevator access, prestige-level building amenities.

### Tier 4 — Ultra-Luxury
Rare, one-of-a-kind estates distinguished by architectural significance, designer interiors, expansive square footage, and prestige locations. Properties at this tier carry an inherent uniqueness — through the architect, the site, the design, or the story — that places them in a category competitors can't replicate. Demand is partly emotional, not just rational.
Price ceiling: —
PPSF ceiling: —
Examples:
- Architect-signed estate in Empire Pass (Upper Deer Valley) with ski-in/ski-out access, 6000+ sqft, custom millwork by a named designer, mountain-iconic views.
- One-of-one modern mountain estate in Lakeside (Jordanelle), waterfront, designed by a notable firm, indoor-outdoor living that defines the property.
- Iconic Old Town/Main Street historic remodel with preserved heritage details, museum-quality interiors, prestige walk-to-Main location, story-driven property.
- Mountain modern compound in Hideout with sweeping reservoir views, multiple structures, equestrian or recreational acreage, designer-pedigreed throughout.

## Amenity Framework

Apply amenities AFTER selecting the base anchor revenue from the sub-market × bedroom × tier grid. Amenities are multipliers on the base anchor, not adjustments to the tier itself.

### Primary Amenities

Three amenity categories drive significant revenue lift. They are applied with diminishing returns — only the largest applies at full value; subsequent ones contribute a fixed +5% each.

| Amenity | Lift | Geographic Scope | Qualifier |
|---|---|---|---|
| Ski-in/ski-out access | 35% | Upper Deer Valley, Lower Deer Valley, Canyons Village, Deer Valley East Village, Old Town / Main St | — |
| Exceptional sleeping capacity | 15% | — | max occupancy >= bedrooms*2 + 4 |
| Iconic/unique | 20% | — | qualitative (architecture, views, design) |

The 35% ski-in/ski-out lift is the working midpoint of an analyst-discretion range of 30-40%; raise or lower within that band when the listing's actual ski-access quality deviates from the norm for the sub-market.

#### Definitions

**Ski-in/ski-out access.** The property is directly on a ski run, allowing guests to ski to and from the door without driving or shuttling. Walking distance to a lift does not qualify. Only applies in sub-markets where ski-in/ski-out properties exist (the sub-markets listed in Geographic Scope). For Old Town / Main St, qualifying listings are limited to the west side of Old Town and properties immediately adjacent to the town lift.

**Exceptional sleeping capacity.** The property sleeps at least 4 more guests than the standard "2 per bedroom" baseline. Examples: a 4BR that sleeps 12+, a 5BR that sleeps 14+, a 6BR that sleeps 16+. Determined by the listing's stated max occupancy, not by counting beds.

**Iconic/unique.** The property has a "can't easily replicate" quality that drives emotional rather than rational demand. Qualifying attributes include: exceptional or signature architecture; iconic views (themselves a draw, marketable in promotional material); extraordinary interior design or designer pedigree; rare experiential elements (private lake, preserved heritage structure, one-of-one estate); unusually strong indoor/outdoor integration that defines the property. This is qualitative — when uncertain, do not apply.

#### Diminishing Returns Rule

When multiple primary amenities apply: identify all qualifying primaries, apply the LARGEST at full value, then add a flat +5% for each additional primary (regardless of its standalone value).

Examples:
- Ski-in/ski-out only: +35%.
- Ski-in/ski-out AND exceptional sleeping capacity: +35% + 5% = +40% (not +50%).
- All three primaries: +35% + 5% + 5% = +45% (not +75%).
- Exceptional sleeping capacity AND iconic uniqueness, no ski-in/ski-out: +20% (uniqueness, the largest) + 5% (capacity) = +25%.

### Secondary Amenities

A separate stack of smaller amenities. These contribute only when at least 3 are present. Amenities not in this list do not count toward the threshold.

- Hot tub
- Game room
- Theater room
- Sauna / steam room
- Golf simulator
- Heated driveway
- Firepit
- Fitness room
- Exceptional views

"Exceptional views" here refers to great mountain or valley views that are not iconic-level (iconic views belong under the primary `Iconic/unique` amenity instead).

Threshold rule:
- 3+ secondaries present AND any primary amenity applies: +3%
- 3+ secondaries present AND no primary amenity applies: +10%
- Fewer than 3 secondaries present: no lift from secondaries.

### Final Calculation

`final_revenue = base_anchor × (1 + primary_lift) × (1 + secondary_lift)`

Where `primary_lift` and `secondary_lift` are decimal multipliers (e.g., 0.35 for 35%). If no primary or secondary amenities apply, the base anchor is the final revenue.

### Avoiding Double-Counting

The luxury tier classification reflects the property's quality, design, materials, and prestige — NOT specific amenities. A Tier 3 property without ski-in/ski-out should anchor on the base Tier 3 grid; a Tier 3 property WITH ski-in/ski-out should anchor on the same Tier 3 grid and apply the +35% multiplier. Do not "round up" the tier to account for amenities.

## Sub-Markets

<!-- Anchors: 3 total (Old Town/Main St, Lakeside, Jordanelle Ridge). Each carries a full annual-revenue grid (bedrooms 1-6 × tiers 1-4) and typical ADR/occupancy ranges by tier. Use "—" for cells where listings at that bedroom/tier combo do not realistically exist. -->

### Old Town / Main St  [ANCHOR]
Market: Park City

Profile: The historic walkable district along Main Street and the surrounding hillside. Character-driven properties — old miner's cottages, historic remodels, modern infill, and condos. Walk-everything appeal sets this apart from every other sub-market.

Sub-market modifiers:
- Ski-in/ski-out properties present: yes, but more "close to skiing". The west side of Old Town and properties near the town lift can be considered ski-in/ski-out.
- Typical luxury tier distribution: Tier 1 to Tier 4 all present.
- Walkability/transit: high (unusually good for the area).
- Seasonality bias: ski season is peak; summer is strong but not as strong; shoulder seasons are better than most sub-markets due to walkability but still dramatically lower than ski.
- Notable considerations: parking is often limited and can constrain rates.

Annual revenue grid (gross, full-year):

| Bedrooms | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|
| 1 | $30,000 | $50,000 | $75,000 | — |
| 2 | $35,000 | $60,000 | $85,000 | $105,000 |
| 3 | $45,000 | $70,000 | $95,000 | $120,000 |
| 4 | $75,000 | $100,000 | $145,000 | $170,000 |
| 5 | — | $175,000 | $215,000 | $290,000 |
| 6 | — | — | $245,000 | $315,000 |

Typical ADR by tier (ski-peak, 4BR baseline):
- Tier 1: $340-$410
- Tier 2: $455-$550
- Tier 3: $720-$995
- Tier 4: $845-$1,035

Typical occupancy by tier (annual average):
- Tier 1: 0.50-0.60
- Tier 2: 0.50-0.60
- Tier 3: 0.40-0.55
- Tier 4: 0.45-0.55

### Lakeside  [ANCHOR]
Market: Jordanelle

Profile: Properties along the Jordanelle Reservoir with water-forward orientation. Mix of condos and townhomes, some older and many brand new, in resort-style developments and single-family homes with reservoir views. Strong summer demand driven by water recreation, with steady ski-season demand from proximity to Deer Valley East Village.

Sub-market modifiers:
- Ski-in/ski-out properties present: no (but close to Deer Valley East Village access).
- Typical luxury tier distribution: Tier 2 to Tier 4, weighted Tier 3.
- Walkability/transit: low; cars expected for the next several years while infrastructure is built.
- Seasonality bias: more balanced than ski-only sub-markets — strong summer plus ski season.
- Notable considerations: reservoir views are a key differentiator and command meaningful premiums.

Annual revenue grid (gross, full-year):

| Bedrooms | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|
| 1 | $25,000 | $35,000 | $45,000 | — |
| 2 | $35,000 | $45,000 | $60,000 | $85,000 |
| 3 | $45,000 | $60,000 | $80,000 | $100,000 |
| 4 | $55,000 | $80,000 | $125,000 | $185,000 |
| 5 | — | $120,000 | $175,000 | $230,000 |
| 6 | — | — | $225,000 | $245,000 |

Typical ADR by tier (ski-peak, 4BR baseline):
- Tier 1: $275-$335
- Tier 2: $335-$400
- Tier 3: $525-$625
- Tier 4: $780-$920

Typical occupancy by tier (annual average):
- Tier 1: 0.45-0.55
- Tier 2: 0.55-0.65
- Tier 3: 0.55-0.65
- Tier 4: 0.55-0.65

### Jordanelle Ridge  [ANCHOR]
Market: Jordanelle

Profile: Higher-elevation development on the Heber-side ridge overlooking the Jordanelle Reservoir. Predominantly newer-construction luxury mountain modern homes with expansive views. Quieter than the resort areas; more residential feel. Growing fast as Park City spillover increases.

Sub-market modifiers:
- Ski-in/ski-out properties present: no (drive to Deer Valley or Park City Mountain).
- Typical luxury tier distribution: Tier 2 to Tier 4, weighted Tier 3.
- Walkability/transit: low; cars required.
- Seasonality bias: ski-peak dominant; summer secondary; sometimes weak shoulder.
- Notable considerations: newer construction means newer photos and listings often outperform older but otherwise comparable properties.

Annual revenue grid (gross, full-year):

| Bedrooms | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|
| 1 | — | — | — | — |
| 2 | — | — | — | — |
| 3 | $40,000 | $53,000 | $85,000 | $105,000 |
| 4 | $55,000 | $70,000 | $110,000 | $175,000 |
| 5 | — | $90,000 | $140,000 | $215,000 |
| 6 | — | $120,000 | $185,000 | $230,000 |

Typical ADR by tier (ski-peak, 4BR baseline):
- Tier 1: $275-$335
- Tier 2: $320-$385
- Tier 3: $465-$550
- Tier 4: $740-$870

Typical occupancy by tier (annual average):
- Tier 1: 0.45-0.55
- Tier 2: 0.50-0.60
- Tier 3: 0.55-0.65
- Tier 4: 0.55-0.65

<!-- Derived sub-markets: 17 total. Each carries a Revenue factor (uniform OR per-tier), an Occupancy delta (uniform), and a one-paragraph note. Chain references (DERIVED from X where X is itself derived) are permitted; the parser resolves chains at runtime so updates to intermediate sub-markets propagate to dependents. -->

<!-- Revenue factor accepts two forms — pick whichever fits the sub-market: -->
<!-- -->
<!-- Form A (uniform across tiers):                          Form B (per-tier overrides): -->
<!--     Revenue factor: 0.85                                    Revenue factor: -->
<!--                                                             - Tier 1: 0.70 -->
<!--                                                             - Tier 2: 0.70 -->
<!--                                                             - Tier 3: 0.85 -->
<!--                                                             - Tier 4: omit if not applicable -->
<!-- -->
<!-- A missing tier line in Form B means no listings at that tier exist for this sub-market — -->
<!-- the parser will fall back to nearest-defined-tier per the sparse-grid walk. -->
<!-- Occupancy delta is always uniform across tiers. -->

<!-- Park City: 10 derived (9 chained off Old Town / Main St directly or transitively; 1 — East Basin Promontory Tier 3-4 — points at Lakeside). -->

### Lower Deer Valley  [DERIVED from Old Town / Main St]
Market: Park City
Revenue factor:
- Tier 2: 0.88
- Tier 3: 0.88
- Tier 4: 0.83
Occupancy delta: 0
Notes: Premium-weighted by virtue of proximity to Deer Valley. Lower Deer Valley anchor numbers run roughly 10-15% below Old Town at Tier 2-3, and 15-20% below at Tier 4 due to being slightly further from downtown access and not as close to skiing. Occupancy patterns are similar; ADR is the main driver. Ski-in/ski-out exists in some buildings and triggers the standard primary amenity multiplier on top. Less walkability than Old Town, so summer/shoulder occupancy is slightly weaker.

### Upper Deer Valley  [DERIVED from Old Town / Main St]
Market: Park City
Revenue factor:
- Tier 2: 1.13
- Tier 3: 1.13
- Tier 4: 1.20
Occupancy delta: 0
Notes: Significantly premium to Old Town. Roughly 10-15% above at Tier 2-3, and 15-25% above at Tier 4. This is the highest-ADR sub-market in the entire Wasatch Back. Empire Pass specifically commands meaningful additional premiums even within Upper Deer Valley. Tier 1 essentially does not exist here. Ski-in/ski-out is common and triggers the standard amenity multiplier on top of these elevated base numbers.

### Canyons Village  [DERIVED from Lower Deer Valley]
Market: Park City
Revenue factor: 0.93
Occupancy delta: 0
Notes: Runs roughly 5-10% below Lower Deer Valley at equivalent tier and bedroom count. Ski-in/ski-out exists in some buildings. Generally a more condo-heavy market than Lower Deer Valley, which means slightly lower ceilings at the high end but solid mid-tier performance. Strong summer demand from concerts and events at the resort.

### Pinebrook / Jeremy Ranch / Summit Park  [DERIVED from Old Town / Main St]
Market: Park City
Revenue factor:
- Tier 1: 0.70
- Tier 2: 0.70
- Tier 3: 0.70
Occupancy delta: 0
Notes: Residential neighborhoods with materially less STR demand pull than the resort-proximate areas. Runs roughly 25-35% below Old Town at equivalent tier 1-3 for 1-3 bedroom listings. Tier 4 essentially does not exist here. The notable exception is larger family-friendly Tier 3 homes with hot tubs and garage parking for ski-trip groups — those have significant draw for guests prioritizing Salt Lake proximity plus skiing access, and perform only 10-15% below Old Town. The schema collapses this to one Tier 3 factor (0.70 for the dominant case); the family-home exception should be applied as a manual override at evaluation time when applicable.

### Kimball Junction  [DERIVED from Old Town / Main St]
Market: Park City
Revenue factor: 0.65
Occupancy delta: 0
Notes: Runs roughly 30-40% below Old Town at equivalent tier and bedroom count. Condo and townhome dominant. The lowest-priced sub-market in Park City proper. Strong functional appeal — easy resort access via bus, walkable to shopping and restaurants — but no character premium. Tier 4 does not exist here. Mostly Tier 1-2 with a few Tier 3 options.

### Deer Valley East Village  [DERIVED from Upper Deer Valley]
Market: Park City
Revenue factor: 0.70
Occupancy delta: 0
Notes: Runs roughly 25-35% below Upper Deer Valley for equivalent tier and bedroom currently. Newer development area with rapid growth around the East Village portal; Tier 3-4 weighted. Ski-in/ski-out access is a major draw and is gated through the primary amenity multiplier. Currently underperforming its long-term ceiling due to large amounts of construction and the lack of mature on-site amenities pulling demand down. Trending up fast as the development matures and amenities come online.

### Park City North (Glen Wild / Racquet Club)  [DERIVED from Pinebrook / Jeremy Ranch / Summit Park]
Market: Park City
Revenue factor: 1.00
Occupancy delta: 0
Notes: Performs roughly similarly to Pinebrook / Jeremy Ranch / Summit Park — residential area, drive to resorts, mostly Tier 2-3 with a few Tier 4 options. Slightly more inventory variation here.

### East Basin  [DERIVED from Pinebrook / Jeremy Ranch / Summit Park]
Market: Park City
Revenue factor: 0.95
Occupancy delta: 0
Notes: Area along US-189 from the I-80 exit up to the top of the mountain looking down to East Village. Similar profile to Pinebrook — residential, drive to resorts. Approximately on par or 5% below Pinebrook. Use this entry for Tier 1-2 properties in the East Basin area, and for Promontory properties at Tier 1-2. Tier 3-4 Promontory properties anchor on the separate "East Basin (Promontory Tier 3-4)" sub-market below.

### East Basin (Promontory Tier 3-4)  [DERIVED from Lakeside]
Market: Park City
Revenue factor:
- Tier 3: 1.00
- Tier 4: 1.00
Occupancy delta: 0
Notes: Applies ONLY to Tier 3-4 Promontory properties — high-end Promontory homes that perform similarly to Lakeside (Jordanelle) rather than the surrounding East Basin / Pinebrook factor. Lower-tier Promontory properties should anchor on the "East Basin" entry instead. The classifier in Phase 5 needs disambiguation logic to pick the right anchor for Promontory listings based on tier.

### Silver Summit  [DERIVED from Pinebrook / Jeremy Ranch / Summit Park]
Market: Park City
Revenue factor: 0.93
Occupancy delta: 0
Notes: Further east on I-80 than Kimball Junction, on the north side of the road. Performs roughly 5-10% below Pinebrook. Predominantly residential single-family. Mostly Tier 1-3.

<!-- Jordanelle: 2 derived (anchored on Jordanelle Ridge). -->

### Hideout  [DERIVED from Jordanelle Ridge]
Market: Jordanelle
Revenue factor: 1.00
Occupancy delta: 0
Notes: Performs roughly the same as Jordanelle Ridge with similar tier mix and drive-time access. Lake-view properties at higher elevations command a 5-10% premium over equivalent inland properties due to reservoir vistas; this should be handled via the `Iconic/unique` primary amenity for view-driven estates with truly outstanding outdoor spaces, rather than baked into the factor. Tier 4 properties tend to be view-driven estates with outstanding outdoor spaces.

### South Valley  [DERIVED from Jordanelle Ridge]
Market: Jordanelle
Revenue factor: 0.93
Occupancy delta: 0
Notes: Along state road 32 from US-189 east to Francis. Roughly 5-10% below Jordanelle Ridge based on qualitative reasoning: further drive to ski resorts, fewer view premiums, less developed amenity infrastructure. Source note used contradictory framing ("materially below" vs "roughly even" in the same paragraph) — 0.93 is the working midpoint of the 0.90-0.95 band, flag for verification on review. A lot of new Tier 3 and some Tier 4 homes coming online here.

<!-- Heber-Midway: 4 derived (anchored on Jordanelle Ridge). -->

### North Fields  [DERIVED from Jordanelle Ridge]
Market: Heber-Midway
Revenue factor: 1.05
Occupancy delta: 0
Notes: Performs roughly 5% above Jordanelle Ridge at equivalent tier and bedroom count. Residential character, agricultural surroundings, less direct view appeal than the Ridge but closer to skiing and more space. Strong family-home appeal — larger lots and outdoor space.

### Heber Town Center  [DERIVED from Jordanelle Ridge]
Market: Heber-Midway
Revenue factor: 0.75
Occupancy delta: 0
Notes: Runs roughly 20-30% below Jordanelle Ridge at equivalent tier and bedroom count. Mostly Tier 1-2 with limited Tier 3. Walkability to Main Street is a modest amenity but doesn't carry the resort-area premiums. Most affordable Heber sub-market. Tier 4 does not exist here.

### Midway  [DERIVED from Jordanelle Ridge]
Market: Heber-Midway
Revenue factor: 0.90
Occupancy delta: 0
Notes: Performs roughly 5-15% below Jordanelle Ridge at equivalent tier and bedroom count. Distinct character — Swiss/agricultural village feel, hot springs nearby, walkable town center. Charm-driven property at the high end can punch above its weight at Tier 3, especially with unique architectural character (which would then also trigger the `Iconic/unique` primary amenity multiplier on top of the base). Soldier Hollow Nordic Center and Wasatch Mountain State Park drive some shoulder-season demand.

### Heber Mountains  [DERIVED from Jordanelle Ridge]
Market: Heber-Midway
Revenue factor:
- Tier 1: 1.00
- Tier 2: 1.00
- Tier 3: 1.08
- Tier 4: 1.08
Occupancy delta: 0
Notes: Higher-elevation properties in this area can command premium views and tend toward larger Tier 3-4 luxury homes. Approximately on par with Jordanelle Ridge at Tier 1-2, and roughly 5-10% above at Tier 3-4 specifically. View-driven; properties without significant mountain or valley views drop meaningfully below the listed factors. Performs much better in summer due to elevation and cooler temperatures but worse in winter given the drive to skiing — annual revenue still balances out near the listed factors.

<!-- Kamas/Oakley: 1 derived (chained off Heber Town Center). -->

### Kamas/Oakley  [DERIVED from Heber Town Center]
Market: Kamas/Oakley
Revenue factor: 0.90
Occupancy delta: 0
Notes: Performs roughly 5-15% below Heber Town Center at equivalent tier and bedroom count. Furthest from resort access in the Wasatch Back service area. Mostly Tier 1-2 inventory with some emerging Tier 3 ranch and farmhouse properties. Best performers are larger family/group homes with strong outdoor amenities (hot tubs, firepits). Tier 4 essentially does not exist. Mirror Lake area has some seasonal summer appeal from fishing and dispersed recreation.
