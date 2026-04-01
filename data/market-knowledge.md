# Park City STR Market Knowledge

Reference data for generating revenue projections when API data (AirDNA, PriceLabs) is unavailable. This will be replaced by real comp data once API keys are configured.

## Seasonality Pattern

| Season | Months | Demand | Notes |
|---|---|---|---|
| Ski Peak | Dec-Mar | Highest | Deer Valley/PCMR ski season. Christmas-New Year and Presidents Day are premium weeks. |
| Summer | Jun-Aug | Secondary peak | Hiking, biking, concerts, festivals. Steady demand but lower ADR than ski. |
| Shoulder | Apr-May | Low | Mud season. Resorts closed, trails not yet open. Lowest occupancy of the year. |
| Fall Shoulder | Sep-Nov | Low-Medium | Leaf season has some demand. Sundance Film Festival prep in late Jan boosts early bookings. Nov picks up for Thanksgiving and early ski. |

## ADR Ranges by Area and Tier (2BR baseline)

| Area | Standard | Premium Finishes | Luxury/Ski-in |
|---|---|---|---|
| Lower Deer Valley | $400-500 | $475-600 | $600-800 |
| Upper Deer Valley | $500-650 | $600-750 | $750-1,200 |
| Park City Core (Old Town/Main St) | $350-450 | $425-550 | $550-800 |
| Canyons Village | $375-475 | $450-575 | $575-850 |
| Pinebrook/Jeremy Ranch | $275-375 | $350-450 | N/A |
| Kimball Junction | $250-350 | $325-425 | N/A |
| Jordanelle | $300-400 | $375-475 | $475-650 |
| Heber/Midway | $225-325 | $300-400 | $400-550 |
| Kamas/Oakley | $200-300 | $275-375 | N/A |

These are ski-season peak ADRs. Multiply by:
- Summer: 0.75-0.85x
- Fall shoulder: 0.65-0.75x
- Spring shoulder: 0.55-0.70x

## Occupancy Ranges (annual average)

| Tier | Occupancy | Description |
|---|---|---|
| Top performers | 70-80% | Ski-in/ski-out, luxury finishes, prime location, Superhost, professional management |
| Above average | 60-70% | Good location, well-furnished, responsive management |
| Average | 50-60% | Decent property, standard finishes, competitive pricing |
| Below average | 40-50% | Dated finishes, inconvenient location, or new listing with no reviews |

## Bedroom Count ADR Multipliers (relative to 2BR)

| Bedrooms | Multiplier | Typical sleeping capacity |
|---|---|---|
| 1 BR | 0.65-0.75x | 2-4 guests |
| 2 BR | 1.0x (baseline) | 4-8 guests |
| 3 BR | 1.25-1.40x | 6-10 guests |
| 4 BR | 1.50-1.75x | 8-12 guests |
| 5+ BR | 1.75-2.25x | 10-16 guests |

## Premium Feature ADR Adjustments

| Feature | ADR Bump | Notes |
|---|---|---|
| Premium/luxury finishes | +$50-75/night | Recent remodel, designer furnishings, high-end appliances |
| Hot tub (private) | +$25-50/night | Nearly expected at higher price points |
| Ski-in/ski-out | +$100-200/night | Biggest single differentiator |
| Mountain/ski area views | +$25-40/night | Especially valuable in winter |
| Game room / entertainment | +$20-35/night | Pool table, arcade, theater room |
| Sauna / steam room | +$15-25/night | |
| Garage parking | +$10-20/night | Valuable in winter |
| On bus route | +$10-15/night | Free transit to resorts |
| Pet friendly | Slight occupancy boost | Expands addressable market |

## New Listing Penalty

Properties in their first 6 months on Airbnb/VRBO typically underperform by:
- **Year 1 occupancy**: 10-15% below established listings (no reviews, no search ranking history)
- **Year 1 ADR**: Can often launch at full rate if photos/listing are strong
- Conservative scenario should apply the full penalty; Optimized scenario assumes quick ramp-up

## HOA / Expense Benchmarks

These are NOT deducted from revenue projections (gross revenue is what we report), but useful context:
- Typical HOA in Deer Valley condos: $3,000-6,000/quarter
- Property management fee: 20-30% of gross revenue
- Cleaning turnover: $150-300 per stay
- Supplies/maintenance reserve: 3-5% of gross revenue

## Adjustment History Patterns

Check the Adjustments sheet before generating projections. Common patterns to watch for:
- Premium finishes in Deer Valley consistently bumped ~14% (first recorded adjustment: MLS 12601192)
- As more adjustments are logged, update this section with observed patterns by category

---

*Last updated: 2026-03-31. This document is a stopgap until AirDNA/PriceLabs API integrations are live.*
