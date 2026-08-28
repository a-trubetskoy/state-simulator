// Population and GDP for the non-US units of the North America map.
//
// Unlike the US county data, these are a static, hand-compiled table rather
// than a downloaded dataset: they are ~80 numbers total, the sources are
// scattered across three national statistics agencies plus the World Bank,
// and the app only needs population and nominal GDP for them.
//
// The Canadian rows are no longer map units — the map draws Canada as census
// divisions — and only their `gdp` is still read, as the provincial control
// total the build apportions across a province's divisions, so a province
// still totals the published figure however finely the map cuts it up. Their
// `pop` is unused: Statistics Canada publishes population per census division,
// so the build takes the real thing and a province is simply the sum of its
// divisions. The numbers are kept here as the published cross-check they were.
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
    "MX-CMX": { pop: 9_210_000, gdp: 285 * B }, // Ciudad de México
    "MX-DIF": { pop: 9_210_000, gdp: 285 * B }, // (older ISO code for CDMX)
    "MX-MEX": { pop: 17_600_000, gdp: 165 * B }, // México (state)
    "MX-NLE": { pop: 6_100_000, gdp: 150 * B }, // Nuevo León
    "MX-JAL": { pop: 8_800_000, gdp: 135 * B }, // Jalisco
    "MX-GUA": { pop: 6_400_000, gdp: 80 * B }, // Guanajuato
    "MX-VER": { pop: 8_100_000, gdp: 80 * B }, // Veracruz
    "MX-BCN": { pop: 3_900_000, gdp: 72 * B }, // Baja California
    "MX-CHH": { pop: 3_900_000, gdp: 70 * B }, // Chihuahua
    "MX-COA": { pop: 3_400_000, gdp: 70 * B }, // Coahuila
    "MX-SON": { pop: 3_100_000, gdp: 65 * B }, // Sonora
    "MX-TAM": { pop: 3_700_000, gdp: 55 * B }, // Tamaulipas
    "MX-PUE": { pop: 6_800_000, gdp: 55 * B }, // Puebla
    "MX-QUE": { pop: 2_500_000, gdp: 50 * B }, // Querétaro
    "MX-SIN": { pop: 3_100_000, gdp: 45 * B }, // Sinaloa
    "MX-MIC": { pop: 4_900_000, gdp: 45 * B }, // Michoacán
    "MX-TAB": { pop: 2_500_000, gdp: 43 * B }, // Tabasco
    "MX-SLP": { pop: 2_900_000, gdp: 42 * B }, // San Luis Potosí
    "MX-CAM": { pop: 1_000_000, gdp: 38 * B }, // Campeche (oil-heavy)
    "MX-ROO": { pop: 2_000_000, gdp: 32 * B }, // Quintana Roo
    "MX-YUC": { pop: 2_400_000, gdp: 30 * B }, // Yucatán
    "MX-HID": { pop: 3_200_000, gdp: 30 * B }, // Hidalgo
    "MX-CHP": { pop: 5_800_000, gdp: 28 * B }, // Chiapas
    "MX-AGU": { pop: 1_500_000, gdp: 28 * B }, // Aguascalientes
    "MX-OAX": { pop: 4_200_000, gdp: 26 * B }, // Oaxaca
    "MX-GRO": { pop: 3_600_000, gdp: 24 * B }, // Guerrero
    "MX-DUR": { pop: 1_900_000, gdp: 22 * B }, // Durango
    "MX-MOR": { pop: 2_000_000, gdp: 19 * B }, // Morelos
    "MX-BCS": { pop: 850_000, gdp: 18 * B }, // Baja California Sur
    "MX-ZAC": { pop: 1_700_000, gdp: 17 * B }, // Zacatecas
    "MX-NAY": { pop: 1_300_000, gdp: 13 * B }, // Nayarit
    "MX-COL": { pop: 750_000, gdp: 11 * B }, // Colima
    "MX-TLA": { pop: 1_400_000, gdp: 10 * B }, // Tlaxcala

    // --- Central America -----------------------------------------------
    GTM: { pop: 18_100_000, gdp: 104 * B }, // Guatemala
    HND: { pop: 10_800_000, gdp: 35 * B }, // Honduras
    SLV: { pop: 6_300_000, gdp: 34 * B }, // El Salvador
    NIC: { pop: 7_000_000, gdp: 18 * B }, // Nicaragua
    CRI: { pop: 5_200_000, gdp: 86 * B }, // Costa Rica
    PAN: { pop: 4_500_000, gdp: 83 * B }, // Panama
    BLZ: { pop: 420_000, gdp: 3.3 * B }, // Belize

    // --- Caribbean ------------------------------------------------------
    CUB: { pop: 10_900_000, gdp: 110 * B }, // Cuba (official; unreliable)
    HTI: { pop: 11_900_000, gdp: 20 * B }, // Haiti
    DOM: { pop: 11_400_000, gdp: 122 * B }, // Dominican Republic
    PRI: { pop: 3_200_000, gdp: 118 * B }, // Puerto Rico
    JAM: { pop: 2_800_000, gdp: 20 * B }, // Jamaica
    TTO: { pop: 1_500_000, gdp: 28 * B }, // Trinidad and Tobago
    BHS: { pop: 400_000, gdp: 14 * B }, // The Bahamas
    BRB: { pop: 280_000, gdp: 6.9 * B }, // Barbados
    LCA: { pop: 180_000, gdp: 2.6 * B }, // Saint Lucia
    GRD: { pop: 113_000, gdp: 1.4 * B }, // Grenada
    VCT: { pop: 101_000, gdp: 1.1 * B }, // St. Vincent and the Grenadines
    ATG: { pop: 94_000, gdp: 2.1 * B }, // Antigua and Barbuda
    DMA: { pop: 67_000, gdp: 0.7 * B }, // Dominica
    KNA: { pop: 47_000, gdp: 1.1 * B }, // Saint Kitts and Nevis
    VIR: { pop: 85_000, gdp: 4.7 * B }, // US Virgin Islands
    CYM: { pop: 73_000, gdp: 7.1 * B }, // Cayman Islands
    TCA: { pop: 47_000, gdp: 1.4 * B }, // Turks and Caicos Islands
    VGB: { pop: 31_000, gdp: 1.7 * B }, // British Virgin Islands
    AIA: { pop: 16_000, gdp: 0.4 * B }, // Anguilla
    MSR: { pop: 4_400, gdp: 0.08 * B }, // Montserrat
    ABW: { pop: 108_000, gdp: 3.9 * B }, // Aruba
    CUW: { pop: 150_000, gdp: 3.4 * B }, // Curaçao
    SXM: { pop: 44_000, gdp: 1.6 * B }, // Sint Maarten
    MAF: { pop: 32_000, gdp: 0.7 * B }, // Saint-Martin (French part)
    BLM: { pop: 11_000, gdp: 0.6 * B }, // Saint-Barthélemy
    GLP: { pop: 380_000, gdp: 11 * B }, // Guadeloupe
    MTQ: { pop: 350_000, gdp: 10 * B }, // Martinique
    BES: { pop: 30_000, gdp: 0.8 * B }, // Caribbean Netherlands (Bonaire…)
  })
);

// GDP is rounded; population is the estimate the id's source publishes.
// The build warns about any map unit that has no row here, so a Natural
// Earth id change shows up as a build message instead of a silent zero.
