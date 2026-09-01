// Population, GDP, education, and income for the non-US units of the North
// America map.
//
// Unlike the US county data, these are a static, hand-compiled table rather
// than a downloaded dataset: the sources are scattered across national
// statistics agencies, the World Bank, and UNESCO, and none of it changes
// often enough to be worth a live pipeline.
//
// The Canadian rows are no longer map units — the map draws Canada as census
// divisions — and only their `gdp` is still read, as the provincial control
// total the build apportions across a province's divisions, so a province
// still totals the published figure however finely the map cuts it up. Their
// `pop` is unused: Statistics Canada publishes population per census division,
// so the build takes the real thing and a province is simply the sum of its
// divisions. The numbers are kept here as the published cross-check they were.
// Canadian divisions get their own real education, income, and race/ethnicity
// figures from the census profile (see loadCaProfile and caRace in
// build-data.mjs), so no `bachPct`/`mhi` is needed on the Canadian rows below.
//
// Values are rounded estimates:
//
//   Canada:  Statistics Canada — population estimates Q3 2024; provincial
//            nominal GDP 2023, converted at ~0.74 USD/CAD.
//   Mexico:  INEGI/CONAPO — population 2024; state share of nominal GDP
//            (INEGI 2023) applied to Mexico's ~$1.8T nominal GDP.
//   Others:  World Bank / national accounts, 2023–24 nominal GDP; UN 2024
//            population. Cuba's GDP is the official figure and is widely
//            considered unreliable. Small territories use local statistics
//            office estimates.
//
// `gdp` is in thousands of current US dollars, matching the BEA county GDP
// units, so foreign units sum and rank directly against US counties.
// Keys are the unit ids the geometry build derives from Natural Earth:
// ISO 3166-2 for Canadian provinces and Mexican states, ISO alpha-3 for
// Caribbean and Central American countries and territories.
//
// `bachPct` is the share of the adult population with a bachelor's degree or
// higher, and `mhi` is household income in current US dollars — both rough,
// non-rigorous estimates in the spirit of the rest of this table:
//
//   Mexico:  bachPct from INEGI's 2020 census share of the population 15+
//            whose highest schooling is "superior" (any tertiary), scaled by
//            a flat 0.7 completion factor (the national ratio of completed
//            licenciatura+posgrado to any tertiary schooling) to approximate
//            a finished bachelor's degree — a state-level average, not a
//            per-state completion rate, so it drifts where a state's mix of
//            finished-vs-unfinished tertiary schooling differs from the
//            national one. `mhi` is INEGI's ENIGH 2024 average annual
//            household income by state, converted at a flat 18 MXN/USD.
//   Others:  bachPct is a mix of measured census/survey figures (years vary
//            widely, 2001–2023) and rough estimates for places with no
//            recent breakdown — see the per-country years below. `mhi` has
//            no real household-income survey for almost any of these units,
//            so it is built from World Bank GNI per capita (Atlas method,
//            mostly 2023–24) times a flat 1.5 — a blunt stand-in for
//            household pooling net of the usual gap between mean GNI and a
//            median household figure. Puerto Rico and the US Virgin Islands
//            use directly known/estimated household income instead of the
//            GNI formula, since applying it there visibly overshoots (Puerto
//            Rico in particular has a GNI/personal-income split unusually
//            wide even for this list, from profit-shifting by mainland
//            firms). None of this should be read as more precise than it is
//            — it exists so foreign units aren't stuck at "—" on two of the
//            app's rankings, not as a citable economic figure.
//
// `life` is a real figure everywhere it appears, not a rough estimate like
// `bachPct`/`mhi` above:
//
//   Mexico:  INEGI's own annual life-table series (2025 estimate, both sexes
//            at birth) — the same rigor as the StatCan tables Canada's
//            divisions read, just not broken down below the state, so there
//            is no finer piece to build here the way Alberta's and BC's
//            divisions get one.
//   Others:  the UN World Population Prospects 2024 revision's 2023
//            both-sexes-at-birth estimate — a real demographic estimate
//            rather than a national statistics office figure, which is the
//            best available source for most of these, especially the
//            smaller territories.
//
// None of these get a finer-than-country/state split: they're already single
// map units, so there's nothing below them to refine.

const B = 1e6; // $1B in thousands of dollars

export const NA_UNIT_STATS = new Map(
  Object.entries({
    // --- Canada: provinces and territories -----------------------------
    "CA-ON": { pop: 16_033_000, gdp: 838 * B }, // Ontario
    "CA-QC": { pop: 9_056_000, gdp: 448 * B }, // Quebec
    "CA-BC": { pop: 5_722_000, gdp: 325 * B }, // British Columbia
    "CA-AB": { pop: 4_960_000, gdp: 337 * B }, // Alberta
    "CA-MB": { pop: 1_512_000, gdp: 68 * B }, // Manitoba
    "CA-SK": { pop: 1_250_000, gdp: 71 * B }, // Saskatchewan
    "CA-NS": { pop: 1_089_000, gdp: 45 * B }, // Nova Scotia
    "CA-NB": { pop: 861_000, gdp: 34 * B }, // New Brunswick
    "CA-NL": { pop: 553_000, gdp: 30 * B }, // Newfoundland and Labrador
    "CA-PE": { pop: 180_000, gdp: 7.1 * B }, // Prince Edward Island
    "CA-NT": { pop: 45_000, gdp: 4.1 * B }, // Northwest Territories
    "CA-YT": { pop: 47_000, gdp: 3.3 * B }, // Yukon
    "CA-NU": { pop: 41_000, gdp: 3.6 * B }, // Nunavut

    // --- Mexico: states ------------------------------------------------
    // `life` is INEGI's 2025 both-sexes life-expectancy-at-birth estimate
    // per state (see the note above); pop/gdp/bachPct/mhi keep their own
    // rougher sourcing.
    "MX-CMX": { pop: 9_210_000, gdp: 285 * B, bachPct: 24.2, mhi: 24_600, life: 77.0 }, // Ciudad de México
    "MX-DIF": { pop: 9_210_000, gdp: 285 * B, bachPct: 24.2, mhi: 24_600, life: 77.0 }, // (older ISO code for CDMX)
    "MX-MEX": { pop: 17_600_000, gdp: 165 * B, bachPct: 15.0, mhi: 16_500, life: 75.3 }, // México (state)
    "MX-NLE": { pop: 6_100_000, gdp: 150 * B, bachPct: 18.3, mhi: 26_000, life: 77.9 }, // Nuevo León
    "MX-JAL": { pop: 8_800_000, gdp: 135 * B, bachPct: 15.6, mhi: 19_400, life: 76.2 }, // Jalisco
    "MX-GUA": { pop: 6_400_000, gdp: 80 * B, bachPct: 11.1, mhi: 16_600, life: 75.1 }, // Guanajuato
    "MX-VER": { pop: 8_100_000, gdp: 80 * B, bachPct: 11.9, mhi: 11_800, life: 73.9 }, // Veracruz
    "MX-BCN": { pop: 3_900_000, gdp: 72 * B, bachPct: 15.1, mhi: 22_500, life: 76.7 }, // Baja California
    "MX-CHH": { pop: 3_900_000, gdp: 70 * B, bachPct: 15.2, mhi: 20_500, life: 76.8 }, // Chihuahua
    "MX-COA": { pop: 3_400_000, gdp: 70 * B, bachPct: 16.6, mhi: 19_500, life: 77.2 }, // Coahuila
    "MX-SON": { pop: 3_100_000, gdp: 65 * B, bachPct: 16.8, mhi: 21_000, life: 76.9 }, // Sonora
    "MX-TAM": { pop: 3_700_000, gdp: 55 * B, bachPct: 15.8, mhi: 17_200, life: 76.0 }, // Tamaulipas
    "MX-PUE": { pop: 6_800_000, gdp: 55 * B, bachPct: 13.6, mhi: 13_800, life: 74.1 }, // Puebla
    "MX-QUE": { pop: 2_500_000, gdp: 50 * B, bachPct: 19.3, mhi: 21_700, life: 76.4 }, // Querétaro
    "MX-SIN": { pop: 3_100_000, gdp: 45 * B, bachPct: 18.9, mhi: 18_400, life: 76.3 }, // Sinaloa
    "MX-MIC": { pop: 4_900_000, gdp: 45 * B, bachPct: 11.5, mhi: 15_200, life: 74.3 }, // Michoacán
    "MX-TAB": { pop: 2_500_000, gdp: 43 * B, bachPct: 14.4, mhi: 14_400, life: 74.0 }, // Tabasco
    "MX-SLP": { pop: 2_900_000, gdp: 42 * B, bachPct: 14.4, mhi: 16_300, life: 75.5 }, // San Luis Potosí
    "MX-CAM": { pop: 1_000_000, gdp: 38 * B, bachPct: 15.6, mhi: 14_700, life: 74.7 }, // Campeche (oil-heavy)
    "MX-ROO": { pop: 2_000_000, gdp: 32 * B, bachPct: 15.1, mhi: 19_700, life: 76.2 }, // Quintana Roo
    "MX-YUC": { pop: 2_400_000, gdp: 30 * B, bachPct: 15.5, mhi: 17_800, life: 75.2 }, // Yucatán
    "MX-HID": { pop: 3_200_000, gdp: 30 * B, bachPct: 13.0, mhi: 13_200, life: 74.1 }, // Hidalgo
    "MX-CHP": { pop: 5_800_000, gdp: 28 * B, bachPct: 9.3, mhi: 9_100, life: 73.2 }, // Chiapas
    "MX-AGU": { pop: 1_500_000, gdp: 28 * B, bachPct: 17.2, mhi: 20_000, life: 77.0 }, // Aguascalientes
    "MX-OAX": { pop: 4_200_000, gdp: 26 * B, bachPct: 9.8, mhi: 11_600, life: 73.5 }, // Oaxaca
    "MX-GRO": { pop: 3_600_000, gdp: 24 * B, bachPct: 10.9, mhi: 10_800, life: 73.3 }, // Guerrero
    "MX-DUR": { pop: 1_900_000, gdp: 22 * B, bachPct: 13.7, mhi: 15_500, life: 75.7 }, // Durango
    "MX-MOR": { pop: 2_000_000, gdp: 19 * B, bachPct: 14.9, mhi: 14_700, life: 74.5 }, // Morelos
    "MX-BCS": { pop: 850_000, gdp: 18 * B, bachPct: 16.2, mhi: 23_300, life: 77.3 }, // Baja California Sur
    "MX-ZAC": { pop: 1_700_000, gdp: 17 * B, bachPct: 12.3, mhi: 13_400, life: 74.6 }, // Zacatecas
    "MX-NAY": { pop: 1_300_000, gdp: 13 * B, bachPct: 15.2, mhi: 16_600, life: 75.8 }, // Nayarit
    "MX-COL": { pop: 750_000, gdp: 11 * B, bachPct: 17.1, mhi: 19_200, life: 76.3 }, // Colima
    "MX-TLA": { pop: 1_400_000, gdp: 10 * B, bachPct: 13.7, mhi: 13_100, life: 74.4 }, // Tlaxcala

    // --- Central America -----------------------------------------------
    // `life` here and in the Caribbean below is the UN World Population
    // Prospects 2024 revision's 2023 both-sexes-at-birth estimate (see the
    // note above) — real for the same reason Mexico's is, just from a UN
    // demographic estimate rather than a national statistics office, since
    // that's the best-available source for several of these, especially the
    // smaller territories.
    GTM: { pop: 18_100_000, gdp: 104 * B, bachPct: 4.3, mhi: 8_700, life: 72.60 }, // Guatemala
    HND: { pop: 10_800_000, gdp: 35 * B, bachPct: 9.6, mhi: 4_500, life: 72.88 }, // Honduras
    SLV: { pop: 6_300_000, gdp: 34 * B, bachPct: 8.3, mhi: 7_700, life: 72.10 }, // El Salvador
    NIC: { pop: 7_000_000, gdp: 18 * B, bachPct: 7.0, mhi: 3_800, life: 74.95 }, // Nicaragua
    CRI: { pop: 5_200_000, gdp: 86 * B, bachPct: 21.6, mhi: 23_400, life: 80.80 }, // Costa Rica
    PAN: { pop: 4_500_000, gdp: 83 * B, bachPct: 19.6, mhi: 27_000, life: 79.59 }, // Panama
    BLZ: { pop: 420_000, gdp: 3.3 * B, bachPct: 7.9, mhi: 11_500, life: 73.57 }, // Belize

    // --- Caribbean ------------------------------------------------------
    CUB: { pop: 10_900_000, gdp: 110 * B, bachPct: 15.3, mhi: 13_400, life: 78.08 }, // Cuba (official; unreliable)
    HTI: { pop: 11_900_000, gdp: 20 * B, bachPct: 2.0, mhi: 2_600, life: 64.94 }, // Haiti
    DOM: { pop: 11_400_000, gdp: 122 * B, bachPct: 18.1, mhi: 15_400, life: 73.72 }, // Dominican Republic
    PRI: { pop: 3_200_000, gdp: 118 * B, bachPct: 29.1, mhi: 24_000, life: 81.69 }, // Puerto Rico (ACS, not the GNI formula)
    JAM: { pop: 2_800_000, gdp: 20 * B, bachPct: 6.8, mhi: 9_700, life: 71.48 }, // Jamaica
    TTO: { pop: 1_500_000, gdp: 28 * B, bachPct: 5.8, mhi: 29_600, life: 73.49 }, // Trinidad and Tobago
    BHS: { pop: 400_000, gdp: 14 * B, bachPct: 15.2, mhi: 55_500, life: 74.55 }, // The Bahamas
    BRB: { pop: 280_000, gdp: 6.9 * B, bachPct: 12.0, mhi: 37_700, life: 76.18 }, // Barbados
    LCA: { pop: 180_000, gdp: 2.6 * B, bachPct: 6.0, mhi: 19_000, life: 72.70 }, // Saint Lucia
    GRD: { pop: 113_000, gdp: 1.4 * B, bachPct: 6.0, mhi: 15_800, life: 75.20 }, // Grenada
    VCT: { pop: 101_000, gdp: 1.1 * B, bachPct: 5.0, mhi: 16_500, life: 71.23 }, // St. Vincent and the Grenadines
    ATG: { pop: 94_000, gdp: 2.1 * B, bachPct: 7.0, mhi: 32_100, life: 77.60 }, // Antigua and Barbuda
    DMA: { pop: 67_000, gdp: 0.7 * B, bachPct: 5.0, mhi: 15_300, life: 71.13 }, // Dominica
    KNA: { pop: 47_000, gdp: 1.1 * B, bachPct: 9.0, mhi: 33_500, life: 72.14 }, // Saint Kitts and Nevis
    VIR: { pop: 85_000, gdp: 4.7 * B, bachPct: 22.3, mhi: 40_000, life: 75.47 }, // US Virgin Islands (estimated, not the GNI formula)
    CYM: { pop: 73_000, gdp: 7.1 * B, bachPct: 29.9, mhi: 92_700, life: 80.36 }, // Cayman Islands
    TCA: { pop: 47_000, gdp: 1.4 * B, bachPct: 16.0, mhi: 52_000, life: 78.01 }, // Turks and Caicos Islands
    VGB: { pop: 31_000, gdp: 1.7 * B, bachPct: 20.0, mhi: 64_500, life: 77.28 }, // British Virgin Islands
    AIA: { pop: 16_000, gdp: 0.4 * B, bachPct: 11.0, mhi: 33_000, life: 79.31 }, // Anguilla
    MSR: { pop: 4_400, gdp: 0.08 * B, bachPct: 9.0, mhi: 22_500, life: 76.19 }, // Montserrat
    ABW: { pop: 108_000, gdp: 3.9 * B, bachPct: 13.0, mhi: 45_200, life: 76.35 }, // Aruba
    CUW: { pop: 150_000, gdp: 3.4 * B, bachPct: 14.0, mhi: 31_500, life: 76.80 }, // Curaçao
    SXM: { pop: 44_000, gdp: 1.6 * B, bachPct: 11.0, mhi: 55_300, life: 76.37 }, // Sint Maarten
    MAF: { pop: 32_000, gdp: 0.7 * B, bachPct: 10.0, mhi: 30_000, life: 80.22 }, // Saint-Martin (French part)
    BLM: { pop: 11_000, gdp: 0.6 * B, bachPct: 20.0, mhi: 67_500, life: 84.29 }, // Saint-Barthélemy
    GLP: { pop: 380_000, gdp: 11 * B, bachPct: 17.0, mhi: 40_500, life: 82.05 }, // Guadeloupe
    MTQ: { pop: 350_000, gdp: 10 * B, bachPct: 18.0, mhi: 43_500, life: 82.56 }, // Martinique
    BES: { pop: 30_000, gdp: 0.8 * B, bachPct: 11.0, mhi: 36_000, life: 77.44 }, // Caribbean Netherlands (Bonaire…)
  })
);

// GDP is rounded; population is the estimate the id's source publishes.
// The build warns about any map unit that has no row here, so a Natural
// Earth id change shows up as a build message instead of a silent zero.
