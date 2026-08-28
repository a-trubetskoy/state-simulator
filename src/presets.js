// Preset regions. Each preset resolves to a set of county FIPS codes:
// whole states via `states`, individual counties via `counties`, minus
// `exclude`. Historical borders that don't follow modern county lines are
// approximated and labeled as such.
//
// `name` is the actual name of the resulting state/entity (used as the
// state's name once created). `label`, if set, is what's shown in the
// preset search dropdown instead — use it when `name` alone would be
// ambiguous or misleading out of context (e.g. disambiguating from another
// preset, or when the preset merges into an existing state).
//
// A `counties` entry is normally a FIPS string (the whole county). It can
// instead be `{ fips, tracts }` for a county the preset only partly claims —
// the same shape "Copy JSON" exports for a carved piece. Applying the preset
// carves that county along the given tract GEOIDs (same engine as the
// freehand knife) and claims only the piece they fall in; the rest of the
// county keeps whatever state it already had.
//
// A preset that splits a place into several states at once (e.g. a "Six
// Californias"-style proposal) uses `parts` instead of `counties`/`states`:
// an array of `{ name, counties }`, one per resulting state. It shows up as
// a single entry in the search dropdown and creates one state per part.

export const PRESETS = [
  {
    id: "socal",
    name: "Southern California",
    desc: "The 10 southernmost counties of California",
    counties: [
      "06025", "06029", "06037", "06059", "06065",
      "06071", "06073", "06079", "06083", "06111",
    ],
  },
  {
    id: "jefferson",
    name: "Jefferson",
    desc: "1941 proposal: far northern California + southern Oregon",
    counties: [
      "06015", "06023", "06035", "06049", "06089", "06093", "06105",
      "41015", "41029", "41033", "41035",
    ],
  },
  {
    id: "new-england",
    name: "New England",
    desc: "CT, ME, MA, NH, RI, and VT as one state",
    states: ["09", "23", "25", "33", "44", "50"],
  },
  {
    id: "midwest",
    name: "Midwest",
    desc: "The 12 states of the Census Midwest region, united",
    states: ["17", "18", "19", "20", "26", "27", "29", "31", "38", "39", "46", "55"],
  },
  {
    id: "dakota",
    name: "Dakota",
    desc: "North and South Dakota reunited, as they were before the Dakota Territory split in two in 1889",
    states: ["38", "46"],
  },
  {
    id: "virginia-1860",
    name: "Virginia (1860)",
    desc: "Virginia before West Virginia split off in 1863",
    states: ["51", "54"],
  },
  {
    id: "franklin",
    name: "Franklin",
    desc: "The lost State of Franklin, 1784 (northeast Tennessee, approx.)",
    counties: ["47019", "47059", "47073", "47091", "47163", "47171", "47179"],
  },
  {
    id: "deseret",
    name: "Deseret",
    desc: "The 1849 Mormon proposal: UT, NV, and neighbors (approx.)",
    states: ["49", "32"],
    counties: [
      "04005", "04012", "04015", "04025", "04027",
      "06025", "06027", "06051", "06065", "06071", "06073",
      "08029", "08033", "08045", "08077", "08081", "08083", "08085", "08103", "08113",
      "35045",
    ],
  },
  {
    id: "superior",
    name: "Superior",
    desc: "Michigan's Upper Peninsula — floated as its own state ('Superior') and, more often, as something to just hand to Wisconsin",
    counties: [
      "26003", "26013", "26033", "26041", "26043", "26053", "26061", "26071",
      "26083", "26095", "26097", "26103", "26109", "26131", "26153",
    ],
  },
  {
    id: "nyc",
    name: "New York City",
    desc: "The five boroughs as the 51st state",
    counties: ["36005", "36047", "36061", "36081", "36085"],
  },
  {
    id: "upstate-ny",
    name: "Upstate New York",
    desc: "New York without NYC, Long Island, and the lower Hudson",
    states: ["36"],
    exclude: [
      "36005", "36047", "36061", "36081", "36085",
      "36059", "36103", "36119", "36087",
    ],
  },
  {
    id: "long-island",
    name: "Long Island",
    desc: "Kings, Queens, Nassau, and Suffolk — the whole island",
    counties: ["36047", "36081", "36059", "36103"],
  },

  // --- California breakup proposals ---
  {
    id: "six-californias",
    name: "Six Californias",
    desc: "Tim Draper's 2014 plan to split California into six states",
    parts: [
      {
        name: "Jefferson",
        counties: [
          "06007", "06011", "06015", "06021", "06023", "06033", "06035",
          "06045", "06049", "06063", "06089", "06093", "06103", "06105",
        ],
      },
      {
        name: "North California",
        counties: [
          "06005", "06017", "06041", "06055", "06057", "06061", "06067",
          "06091", "06095", "06097", "06101", "06113", "06115",
        ],
      },
      {
        name: "Silicon Valley",
        counties: ["06001", "06013", "06053", "06069", "06075", "06081", "06085", "06087"],
      },
      {
        name: "Central California",
        counties: [
          "06003", "06009", "06019", "06027", "06029", "06031", "06039",
          "06043", "06047", "06051", "06077", "06099", "06107", "06109",
        ],
      },
      {
        name: "West California",
        counties: ["06037", "06079", "06083", "06111"],
      },
      {
        name: "South California",
        counties: ["06025", "06059", "06065", "06071", "06073"],
      },
    ],
  },
  {
    id: "cal3",
    name: "Cal 3",
    desc: "Draper's 2018 ballot initiative to split California into three states",
    parts: [
      {
        name: "California",
        counties: ["06037", "06053", "06069", "06079", "06083", "06111"],
      },
      {
        name: "Northern California",
        counties: [
          "06001", "06003", "06005", "06007", "06009", "06011", "06013",
          "06015", "06017", "06021", "06023", "06033", "06035", "06041",
          "06043", "06045", "06047", "06049", "06055", "06057", "06061",
          "06063", "06067", "06075", "06077", "06081", "06085", "06087",
          "06089", "06091", "06093", "06095", "06097", "06099", "06101",
          "06103", "06105", "06109", "06113", "06115",
        ],
      },
      {
        name: "Southern California",
        counties: [
          "06019", "06025", "06027", "06029", "06031", "06039",
          "06051", "06059", "06065", "06071", "06073", "06107",
        ],
      },
    ],
  },

  // --- Official state-agency regions (not breakup proposals, but still a
  // one-preset-many-states split) ---
  {
    id: "ny-ten-regions",
    name: "The Ten Regions of New York",
    desc: "New York split into its 10 Regional Economic Development Council regions, as defined by Empire State Development",
    parts: [
      {
        name: "Western New York",
        counties: ["36003", "36009", "36013", "36029", "36063"],
      },
      {
        name: "Finger Lakes",
        counties: [
          "36037", "36051", "36055", "36069", "36073",
          "36099", "36117", "36121", "36123",
        ],
      },
      {
        name: "Southern Tier",
        counties: [
          "36007", "36015", "36017", "36025",
          "36097", "36101", "36107", "36109",
        ],
      },
      {
        name: "Central New York",
        counties: ["36011", "36023", "36053", "36067", "36075"],
      },
      {
        name: "North Country",
        counties: ["36019", "36031", "36033", "36041", "36045", "36049", "36089"],
      },
      {
        name: "Mohawk Valley",
        counties: ["36035", "36043", "36057", "36065", "36077", "36095"],
      },
      {
        name: "Capital Region",
        counties: [
          "36001", "36021", "36039", "36083",
          "36091", "36093", "36113", "36115",
        ],
      },
      {
        name: "Mid-Hudson",
        counties: [
          "36027", "36071", "36079", "36087",
          "36105", "36111", "36119",
        ],
      },
      {
        name: "New York City",
        counties: ["36005", "36047", "36061", "36081", "36085"],
      },
      {
        name: "Long Island",
        counties: ["36059", "36103"],
      },
    ],
  },

  // --- Other proposed states, historical and modern ---
  {
    id: "absaroka",
    name: "Absaroka",
    desc: "1939 Depression-era proposal: northern Wyoming, southeastern Montana, and western South Dakota (approx.)",
    counties: [
      // Wyoming
      "56029", "56039", "56003", "56017", "56043", "56019", "56033", "56005", "56011", "56045",
      // Montana
      "30011", "30025", "30075", "30017",
      // South Dakota
      "46063", "46019", "46081", "46093", "46103", "46033", "46047", "46105", "46031", "46137", "46055", "46071",
    ],
  },
  {
    id: "texlahoma",
    name: "Texlahoma",
    desc: "1935 Dust Bowl-era proposal to join the Texas and Oklahoma panhandles into one state (approx.; the original plan reached further south and east)",
    counties: [
      // Texas Panhandle
      "48011", "48045", "48065", "48069", "48075", "48087", "48111", "48117", "48129",
      "48179", "48191", "48195", "48205", "48211", "48233", "48295", "48341", "48357",
      "48359", "48369", "48375", "48381", "48393", "48421", "48437", "48483",
      // Oklahoma Panhandle
      "40025", "40139", "40007",
    ],
  },
  {
    id: "forgottonia",
    name: "Forgottonia",
    desc: "1970s mock-secession by 16 western Illinois counties protesting neglect from Springfield",
    counties: [
      "17001", "17009", "17013", "17017", "17057", "17061", "17067", "17071",
      "17095", "17109", "17131", "17137", "17149", "17169", "17171", "17187",
    ],
  },
  {
    id: "baja-arizona",
    name: "Baja Arizona",
    desc: "2011 'Start Our State' proposal: Tucson and Arizona's southern border counties",
    counties: ["04003", "04019", "04023"],
  },
  {
    id: "up-to-wisconsin",
    name: "Wisconsin",
    label: "Scenario: UP to Wisconsin",
    desc: "Wisconsin plus Michigan's Upper Peninsula, which is closer to Wisconsin than to the rest of Michigan and is only rarely floated as a handoff target",
    states: ["55"],
    counties: [
      "26003", "26013", "26033", "26041", "26043", "26053", "26061", "26071",
      "26083", "26095", "26097", "26103", "26109", "26131", "26153",
    ],
  },
  {
    id: "greater-idaho",
    name: "Greater Idaho",
    desc: "Idaho plus the rural eastern Oregon counties that have voted since 2019 to join it",
    states: ["16"],
    counties: [
      "41001", "41013", "41023", "41025", "41031", "41035",
      "41037", "41045", "41049", "41055", "41061", "41069",
    ],
  },
  {
    id: "north-colorado",
    name: "North Colorado",
    desc: "2013 '51st state' referendum: the 5 counties that voted yes (Weld County, the movement's birthplace, voted no)",
    counties: ["08017", "08063", "08095", "08121", "08125"],
  },
  {
    id: "south-jersey",
    name: "South Jersey",
    desc: "1980 secession referendum passed narrowly here, but the split was never enacted",
    counties: ["34001", "34005", "34007", "34009", "34011", "34015", "34029", "34033"],
  },
  {
    id: "delmarva",
    name: "Delmarva",
    desc: "The Delaware/Maryland/Virginia peninsula, floated as its own state since the 1990s",
    counties: [
      // Delaware
      "10003", "10001", "10005",
      // Maryland's Eastern Shore
      "24015", "24029", "24035", "24011", "24041", "24019", "24045", "24039", "24047",
      // Virginia's Eastern Shore
      "51001", "51131",
    ],
  },
  {
    id: "cascadia",
    name: "Cascadia",
    desc: "Pacific Northwest bioregional independence movement (approx.; broader versions add N. California, Idaho, and British Columbia)",
    states: ["53", "41"],
  },
  {
    id: "westsylvania",
    name: "Westsylvania",
    desc: "1776 bid for a 14th colony: all of West Virginia plus adjoining slices of PA, MD, VA, and KY (approx.)",
    states: ["54"],
    counties: [
      // Southwestern Pennsylvania
      "42003", "42125", "42129", "42051", "42059", "42111", "42063", "42005", "42007",
      // Western Maryland
      "24023", "24001",
      // Far southwestern Virginia
      "51105", "51195", "51169", "51051",
      // Eastern Kentucky border counties
      "21195", "21159", "21115",
    ],
  },
  {
    id: "jefferson-territory",
    name: "Jefferson Territory",
    desc: "1859 Pikes Peak gold-rush proposal: all of Colorado plus slices of WY and UT (approx.; unrelated to the 1941 CA/OR 'Jefferson' proposal)",
    states: ["08"],
    counties: [
      // Southern/central Wyoming
      "56021", "56001", "56007", "56037", "56041", "56023", "56035", "56013", "56025", "56009", "56031", "56015",
      // Eastern Utah
      "49009", "49047", "49019", "49037",
    ],
  },
  {
    id: "lincoln",
    name: "Lincoln",
    desc: "1869 congressional proposal: Texas south and west of the Colorado River (rough sketch — the proposal only ever specified a river, not counties)",
    counties: [
      "48003", "48007", "48013", "48019", "48021", "48025", "48029", "48031",
      "48043", "48047", "48055", "48057", "48061", "48089", "48091", "48095",
      "48103", "48105", "48109", "48123", "48127", "48131", "48135", "48137",
      "48141", "48149", "48163", "48165", "48171", "48173", "48175", "48177",
      "48187", "48209", "48215", "48227", "48229", "48235", "48239", "48243",
      "48247", "48249", "48255", "48259", "48261", "48265", "48267", "48271",
      "48273", "48283", "48285", "48297", "48299", "48301", "48307", "48311",
      "48317", "48319", "48321", "48323", "48325", "48327", "48329", "48355",
      "48371", "48377", "48383", "48385", "48389", "48391", "48409", "48411",
      "48413", "48427", "48431", "48435", "48443", "48451", "48453", "48461",
      "48463", "48465", "48469", "48475", "48479", "48481", "48489", "48493",
      "48495", "48505", "48507",
    ],
  },
  {
    id: "texas-five",
    name: "Nate Silver's Texas",
    desc: "Nate Silver's 2009 FiveThirtyEight proposal to split Texas into five states along political and economic lines",
    parts: [
      {
        name: "El Norte",
        counties: [
          "48043", "48047", "48061", "48109", "48127", "48131", "48137", "48141",
          "48163", "48215", "48229", "48243", "48247", "48249", "48271", "48283",
          "48297", "48311", "48323", "48371", "48377", "48385", "48389", "48427",
          "48443", "48463", "48465", "48479", "48505", "48507",
        ],
      },
      {
        name: "Plainland",
        counties: [
          "48003", "48009", "48011", "48017", "48023", "48033", "48035", "48045",
          "48049", "48059", "48065", "48069", "48075", "48077", "48079", "48081",
          "48083", "48087", "48093", "48095", "48099", "48101", "48103", "48105",
          "48107", "48111", "48115", "48117", "48125", "48129", "48133", "48135",
          "48143", "48151", "48153", "48155", "48165", "48169", "48173", "48179",
          "48189", "48191", "48193", "48195", "48197", "48205", "48207", "48211",
          "48219", "48221", "48227", "48233", "48235", "48237", "48253", "48263",
          "48267", "48269", "48275", "48279", "48281", "48295", "48301", "48303",
          "48305", "48307", "48309", "48317", "48319", "48327", "48329", "48333",
          "48335", "48337", "48341", "48345", "48353", "48357", "48359", "48363",
          "48367", "48369", "48375", "48381", "48383", "48393", "48399", "48411",
          "48413", "48415", "48417", "48421", "48425", "48429", "48431", "48433",
          "48435", "48437", "48441", "48445", "48447", "48451", "48461", "48475",
          "48483", "48485", "48487", "48495", "48497", "48501", "48503",
        ],
      },
      {
        name: "Gulfland",
        counties: [
          "48005", "48007", "48015", "48025", "48039", "48041", "48057", "48071",
          "48089", "48157", "48167", "48175", "48185", "48199", "48201", "48225",
          "48239", "48241", "48245", "48261", "48273", "48289", "48291", "48313",
          "48321", "48339", "48351", "48355", "48361", "48373", "48391", "48403",
          "48405", "48407", "48409", "48455", "48457", "48469", "48471", "48473",
          "48477", "48481", "48489",
        ],
      },
      {
        name: "Trinity",
        counties: [
          "48001", "48037", "48063", "48067", "48073", "48085", "48097", "48113",
          "48119", "48121", "48139", "48147", "48159", "48161", "48181", "48183",
          "48203", "48213", "48217", "48223", "48231", "48251", "48257", "48277",
          "48293", "48315", "48343", "48347", "48349", "48365", "48379", "48387",
          "48397", "48401", "48419", "48423", "48439", "48449", "48459", "48467",
          "48499",
        ],
      },
      {
        name: "New Texas",
        counties: [
          "48013", "48019", "48021", "48027", "48029", "48031", "48051", "48053",
          "48055", "48091", "48123", "48145", "48149", "48171", "48177", "48187",
          "48209", "48255", "48259", "48265", "48285", "48287", "48299", "48325",
          "48331", "48395", "48453", "48491", "48493",
        ],
      },
    ],
  },
  {
    id: "transylvania",
    name: "Transylvania",
    desc: "1775 land-speculation colony: central and western Kentucky plus a slice of north-central Tennessee (approx.)",
    states: ["21"],
    exclude: [
      // Eastern Kentucky / Appalachian coalfield counties (outside the Kentucky River line)
      "21001", "21011", "21013", "21019", "21025", "21043", "21045", "21049",
      "21051", "21053", "21057", "21061", "21063", "21065", "21069", "21071",
      "21079", "21087", "21089", "21095", "21099", "21109", "21115", "21119",
      "21121", "21125", "21127", "21129", "21131", "21133", "21135", "21137",
      "21147", "21151", "21153", "21159", "21165", "21169", "21171", "21173",
      "21175", "21181", "21189", "21193", "21195", "21197", "21199", "21201",
      "21203", "21205", "21207", "21231", "21235", "21237",
      // Jackson Purchase counties (not acquired from the Chickasaw until 1818)
      "21007", "21035", "21039", "21075", "21083", "21105", "21157", "21145",
    ],
    counties: [
      // North-central Tennessee (the Cumberland settlements)
      "47037", "47165", "47189", "47149", "47187", "47125", "47147", "47021",
    ],
  },
  {
    id: "nickajack",
    name: "Nickajack",
    desc: "Civil War-era Unionist proposal: East Tennessee plus North Alabama's hill country (approx.)",
    counties: [
      // East Tennessee
      "47001", "47007", "47009", "47011", "47013", "47019", "47025", "47029",
      "47035", "47057", "47059", "47063", "47065", "47067", "47073", "47089",
      "47091", "47093", "47105", "47107", "47115", "47121", "47123", "47129",
      "47139", "47143", "47145", "47151", "47153", "47155", "47163", "47171",
      "47173", "47179",
      // North Alabama hill country
      "01009", "01033", "01043", "01049", "01057", "01059", "01071", "01075",
      "01077", "01079", "01083", "01089", "01093", "01095", "01103", "01127",
      "01133",
    ],
  },
  {
    id: "sequoyah",
    name: "Sequoyah",
    desc: "1905 Five Tribes proposal: the old Indian Territory, roughly eastern Oklahoma (approx.)",
    counties: [
      "40001", "40021", "40035", "40041", "40097", "40105", "40115", "40131",
      "40135", "40145", "40147", "40037", "40063", "40091", "40107", "40111",
      "40101", "40143", "40133", "40005", "40013", "40023", "40029", "40061",
      "40079", "40077", "40089", "40121", "40127", "40019", "40049", "40069",
      "40085", "40095", "40099", "40123", "40137", "40051", "40067", "40113",
    ],
  },
  {
    id: "scott",
    name: "Scott",
    desc: "Scott County, TN seceded from Confederate Tennessee in 1861 to back the Union; rejoined officially only in 1986",
    counties: ["47151"],
  },

  // --- Tennessee's three Grand Divisions ---
  {
    id: "east-tennessee",
    name: "East Tennessee",
    desc: "One of Tennessee's three constitutionally recognized Grand Divisions",
    counties: [
      "47001", "47007", "47009", "47011", "47013", "47019", "47025", "47029",
      "47035", "47057", "47059", "47063", "47065", "47067", "47073", "47089",
      "47091", "47093", "47105", "47107", "47115", "47121", "47123", "47129",
      "47139", "47143", "47145", "47151", "47155", "47163", "47171", "47173",
      "47179",
    ],
  },
  {
    id: "middle-tennessee",
    name: "Middle Tennessee",
    desc: "One of Tennessee's three constitutionally recognized Grand Divisions",
    counties: [
      "47003", "47015", "47021", "47027", "47031", "47037", "47041", "47043",
      "47049", "47051", "47055", "47061", "47081", "47083", "47085", "47087",
      "47099", "47101", "47103", "47111", "47117", "47119", "47125", "47127",
      "47133", "47135", "47137", "47141", "47147", "47149", "47153", "47159",
      "47161", "47165", "47169", "47175", "47177", "47181", "47185", "47187",
      "47189",
    ],
  },
  {
    id: "west-tennessee",
    name: "West Tennessee",
    desc: "One of Tennessee's three constitutionally recognized Grand Divisions",
    counties: [
      "47005", "47017", "47023", "47033", "47039", "47045", "47047", "47053",
      "47069", "47071", "47075", "47077", "47079", "47095", "47097", "47109",
      "47113", "47131", "47157", "47167", "47183",
    ],
  },

  // --- Well-known non-state regions ---
  {
    id: "bay-area",
    name: "Bay Area",
    desc: "The 9-county San Francisco Bay Area",
    counties: ["06001", "06013", "06041", "06055", "06075", "06081", "06085", "06095", "06097"],
  },
  {
    id: "south-florida",
    name: "South Florida",
    desc: "Miami-Dade, Broward, Palm Beach, and Monroe",
    counties: ["12086", "12011", "12099", "12087"],
  },
  {
    id: "chicagoland",
    name: "Chicagoland",
    desc: "Cook County and its six collar counties",
    counties: ["17031", "17043", "17089", "17093", "17097", "17111", "17197"],
  },
  {
    id: "houston-metro",
    name: "Houston Metro",
    desc: "The 9-county Houston-The Woodlands-Sugar Land metropolitan area",
    counties: [
      "48015", "48039", "48071", "48157", "48167",
      "48201", "48291", "48339", "48473",
    ],
  },
  {
    id: "pittsburgh-metro",
    name: "Pittsburgh Metro",
    desc: "The 7-county Pittsburgh metropolitan statistical area",
    counties: [
      "42003", "42005", "42007", "42019", "42051", "42125", "42129",
    ],
  },
  {
    id: "nyc-metro",
    name: "New York Metro",
    desc: "The 22-county New York-Newark-Jersey City metropolitan statistical area (NY/NJ)",
    counties: [
      // New York
      "36005", "36047", "36059", "36061", "36079",
      "36081", "36085", "36087", "36103", "36119",
      // New Jersey
      "34003", "34013", "34017", "34019", "34023", "34025",
      "34027", "34029", "34031", "34035", "34037", "34039",
    ],
  },
  {
    id: "philadelphia-metro",
    name: "Philadelphia Metro",
    desc: "The 11-county Philadelphia-Camden-Wilmington metropolitan statistical area (PA/NJ/DE/MD)",
    counties: [
      // Pennsylvania
      "42017", "42029", "42045", "42091", "42101",
      // New Jersey
      "34005", "34007", "34015", "34033",
      // Delaware
      "10003",
      // Maryland
      "24015",
    ],
  },
  {
    id: "portland-metro",
    name: "Portland Metro",
    desc: "The 7-county Portland-Vancouver-Hillsboro metropolitan statistical area (OR/WA)",
    counties: [
      // Oregon
      "41005", "41009", "41051", "41067", "41071",
      // Washington
      "53011", "53059",
    ],
  },
  {
    id: "rio-grande-valley",
    name: "Rio Grande Valley",
    desc: "Cameron, Hidalgo, Starr, and Willacy — the four southernmost-tip counties of Texas",
    counties: ["48061", "48215", "48427", "48489"],
  },
  {
    id: "south-texas",
    name: "South Texas",
    desc: "The 27 counties commonly grouped as South Texas, from the Rio Grande Plains to the Coastal Bend",
    counties: [
      "48007", "48013", "48025", "48047", "48061", "48127", "48131", "48163",
      "48175", "48215", "48247", "48249", "48255", "48261", "48273", "48283",
      "48297", "48311", "48323", "48355", "48391", "48409", "48427", "48479",
      "48489", "48505", "48507",
    ],
  },
  {
    id: "west-texas",
    name: "West Texas",
    desc: "The 70 counties commonly grouped as West Texas, from the Permian Basin to the Trans-Pecos",
    counties: [
      "48003", "48017", "48033", "48043", "48049", "48059", "48079", "48081",
      "48083", "48093", "48095", "48103", "48105", "48107", "48109", "48115",
      "48125", "48133", "48135", "48141", "48151", "48153", "48165", "48169",
      "48173", "48189", "48207", "48219", "48227", "48229", "48235", "48243",
      "48253", "48263", "48267", "48269", "48275", "48279", "48301", "48303",
      "48305", "48307", "48317", "48319", "48327", "48329", "48335", "48345",
      "48353", "48371", "48377", "48383", "48389", "48399", "48413", "48415",
      "48417", "48429", "48431", "48433", "48435", "48441", "48443", "48445",
      "48447", "48451", "48461", "48475", "48495", "48501",
    ],
  },
  {
    id: "east-texas",
    name: "East Texas",
    desc: "The 38 counties commonly grouped as East Texas, the Piney Woods region toward the Louisiana border",
    counties: [
      "48001", "48005", "48037", "48063", "48067", "48073", "48119", "48159",
      "48183", "48199", "48203", "48213", "48223", "48225", "48241", "48245",
      "48277", "48315", "48343", "48347", "48351", "48361", "48365", "48373",
      "48379", "48387", "48401", "48403", "48405", "48407", "48419", "48423",
      "48449", "48455", "48457", "48459", "48467", "48499",
    ],
  },
  {
    id: "northeastern-pennsylvania",
    name: "Nepa",
    label: "Nepa (Northeastern Pennsylvania)",
    desc: "The 14 counties commonly grouped as Northeastern Pennsylvania (NEPA)",
    counties: [
      "42015", "42025", "42037", "42069", "42079", "42089", "42093",
      "42097", "42103", "42107", "42113", "42115", "42127", "42131",
    ],
  },
  {
    id: "coal-region",
    name: "Coal Region (PA)",
    desc: "The 5 Pennsylvania counties typically defined as the (anthracite) Coal Region",
    counties: ["42025", "42069", "42079", "42097", "42107"],
  },
  {
    id: "dutchland",
    name: "Dutchland",
    desc: "The 9 counties of Pennsylvania Dutch Country, south-central Pennsylvania",
    counties: [
      "42001", "42011", "42041", "42043", "42055",
      "42071", "42075", "42099", "42133",
    ],
  },
  {
    id: "nova",
    name: "Northern Virginia",
    desc: "The 9 jurisdictions of the Northern Virginia Regional Commission: Arlington, Fairfax, Loudoun, Prince William, and five independent cities",
    counties: [
      "51013", "51059", "51107", "51153", "51510",
      "51600", "51610", "51683", "51685",
    ],
  },
  {
    id: "south-georgia",
    name: "South Georgia",
    desc: "The 32 counties of the Southern and Southwest Georgia Regional Commissions",
    counties: [
      "13003", "13005", "13007", "13017", "13019", "13025", "13027", "13037",
      "13049", "13065", "13069", "13071", "13075", "13087", "13095", "13099",
      "13101", "13131", "13155", "13173", "13177", "13185", "13201", "13205",
      "13229", "13253", "13273", "13275", "13277", "13287", "13299", "13321",
    ],
  },
  {
    id: "east-washington",
    name: "East Washington",
    desc: "Washington state east of the Cascades, from the Okanogan highlands to the Palouse",
    counties: [
      "53001", "53003", "53005", "53007", "53013", "53017", "53019", "53021",
      "53023", "53025", "53037", "53039", "53043", "53047", "53051", "53063",
      "53065", "53071", "53075", "53077",
    ],
  },
  {
    id: "east-oregon",
    name: "East Oregon",
    desc: "Oregon east of the Cascade crest — a broader footprint than the Greater Idaho movement's core counties, kept here as its own state",
    counties: [
      "41001", "41013", "41017", "41021", "41023", "41025", "41031", "41035",
      "41037", "41045", "41049", "41055", "41059", "41061", "41063", "41065",
      "41069",
    ],
  },
  {
    id: "southern-oregon",
    name: "Southern Oregon",
    desc: "The broad 7-county definition: Coos, Curry, Douglas, Jackson, Josephine, Klamath, and Lake",
    counties: ["41011", "41015", "41019", "41029", "41033", "41035", "41037"],
  },
  // --- Ohio regions ---
  {
    id: "greater-cincinnati",
    name: "Greater Cincinnati",
    desc: "The 16-county Cincinnati, OH-KY-IN metropolitan statistical area",
    counties: [
      // Ohio
      "39015", "39017", "39025", "39027", "39061", "39165",
      // Kentucky
      "21015", "21023", "21037", "21077", "21081", "21117", "21191",
      // Indiana
      "18029", "18047", "18115",
    ],
  },
  {
    id: "columbus-metro",
    name: "Columbus Metro",
    desc: "The 10-county Columbus, OH metropolitan statistical area",
    counties: [
      "39041", "39045", "39049", "39073", "39089",
      "39097", "39117", "39127", "39129", "39159",
    ],
  },
  {
    id: "northeast-ohio",
    name: "Northeast Ohio",
    desc: "One of the state's 5 official geographic regions, per the Ohio Secretary of State",
    counties: [
      "39005", "39007", "39019", "39029", "39035", "39055", "39067", "39075",
      "39081", "39085", "39093", "39099", "39103", "39133", "39151", "39153",
      "39155", "39157", "39169",
    ],
  },
  {
    id: "northwest-ohio",
    name: "Northwest Ohio",
    desc: "One of the state's 5 official geographic regions, per the Ohio Secretary of State",
    counties: [
      "39003", "39011", "39039", "39043", "39051", "39063", "39065", "39069",
      "39077", "39095", "39107", "39123", "39125", "39137", "39143", "39147",
      "39161", "39171", "39173", "39175",
    ],
  },
  // --- North Carolina regions ---
  {
    id: "triangle-nc",
    name: "Triangle",
    label: "Triangle (NC)",
    desc: "Raleigh/Durham/Chapel Hill: the 9-county Raleigh-Durham-Cary combined statistical area",
    counties: [
      "37037", "37063", "37069", "37077", "37101", "37135", "37145", "37181", "37183",
    ],
  },
  {
    id: "triad-nc",
    name: "Triad",
    label: "Triad (NC)",
    desc: "Greensboro/Winston-Salem/High Point: the 12-county Piedmont Triad Regional Council area",
    counties: [
      "37001", "37033", "37057", "37059", "37067", "37081",
      "37123", "37151", "37157", "37169", "37171", "37197",
    ],
  },
  {
    id: "metrolina",
    name: "Metrolina",
    desc: "The Charlotte region: Mecklenburg plus 9 surrounding NC counties and 2 in SC, per the Metrolina Regional Model",
    counties: [
      // North Carolina
      "37007", "37025", "37045", "37071", "37097",
      "37109", "37119", "37159", "37167", "37179",
      // South Carolina
      "45057", "45091",
    ],
  },
  {
    id: "carolina-banks",
    name: "Carolina Banks",
    desc: "NC's Outer Banks barrier islands plus the 'Inner Banks' tidewater counties behind them (approx.)",
    counties: [
      "37013", "37015", "37029", "37031", "37041", "37049", "37053", "37055",
      "37065", "37073", "37083", "37091", "37095", "37103", "37117", "37131",
      "37133", "37137", "37139", "37143", "37147", "37177", "37187", "37191",
    ],
  },
  // --- Michigan regions ---
  {
    id: "metro-detroit",
    name: "Metro Detroit",
    desc: "The 6-county Detroit-Warren-Dearborn metropolitan statistical area",
    counties: ["26087", "26093", "26099", "26125", "26147", "26163"],
  },
  {
    id: "west-michigan",
    name: "West Michigan",
    desc: "The 13-county West Michigan region as defined by The Right Place, the Grand Rapids area's regional economic development organization",
    counties: [
      "26005", "26015", "26067", "26081", "26085", "26105", "26107",
      "26117", "26121", "26123", "26127", "26133", "26139",
    ],
  },
  {
    id: "mid-michigan",
    name: "Mid-Michigan",
    desc: "The Tri-Cities, Flint, and Lansing areas, commonly grouped by local media and economic-development groups as 'Mid-Michigan' (approx.)",
    counties: [
      "26017", "26037", "26045", "26049", "26065", "26111", "26145", "26155",
    ],
  },

  // --- Minnesota regions ---
  {
    id: "arrowhead-region",
    name: "Arrowhead Region",
    label: "Iron Range / Arrowhead Region",
    desc: "The 7-county service area of the Arrowhead Regional Development Commission, home to Minnesota's Iron Range",
    counties: [
      "27001", "27017", "27031", "27061", "27071", "27075", "27137",
    ],
  },
  {
    id: "twin-cities",
    name: "Twin Cities",
    desc: "The 7-county Minneapolis-St. Paul metro area governed by the Metropolitan Council",
    counties: [
      "27003", "27019", "27037", "27053", "27123", "27139", "27163",
    ],
  },

  // --- Missouri regions ---
  {
    id: "bootheel-mo",
    name: "Bootheel",
    label: "Bootheel (MO)",
    desc: "The 6-county service area of the Bootheel Regional Planning Commission, in Missouri's southeastern lowlands",
    counties: ["29069", "29133", "29143", "29155", "29199", "29205"],
  },
  {
    id: "kansas-city-metro",
    name: "Kansas City Metro",
    desc: "The 14-county Kansas City, MO-KS metropolitan statistical area",
    counties: [
      // Missouri
      "29013", "29025", "29037", "29047", "29049", "29095", "29107", "29165", "29177",
      // Kansas
      "20091", "20103", "20107", "20121", "20209",
    ],
  },
  {
    id: "little-dixie",
    name: "Little Dixie",
    desc: "The 13-county central Missouri region defined by a 1948 Missouri Historical Review study of the state's antebellum hemp-and-tobacco, slaveholding belt",
    counties: [
      "29007", "29019", "29027", "29041", "29089", "29113", "29125",
      "29137", "29163", "29173", "29175", "29193", "29203",
    ],
  },
  {
    id: "st-louis-metro",
    name: "St. Louis Metro",
    desc: "The 15-county St. Louis, MO-IL metropolitan statistical area",
    counties: [
      // Missouri
      "29071", "29099", "29113", "29183", "29189", "29217", "29510",
      // Illinois
      "17005", "17013", "17027", "17083", "17117", "17119", "17133", "17163",
    ],
  },

  {
    id: "delta-ar-ms",
    name: "Delta",
    label: "Delta (AR + MS Delta)",
    desc: "The Arkansas Delta plus the Mississippi Delta, carved along census tract lines where the alluvial plain cuts through a county",
    counties: [
      // Arkansas Delta
      "05001", "05017", "05021", "05031", "05035", "05037", "05041", "05055",
      { fips: "05067", tracts: ["05067480100", "05067480200", "05067480300", "05067480401", "05067480402"] },
      { fips: "05069", tracts: ["05069000102", "05069002300", "05069002500"] },
      { fips: "05075", tracts: ["05075470100", "05075470400", "05075470501", "05075470502"] },
      "05077",
      { fips: "05079", tracts: ["05079960600"] },
      { fips: "05085", tracts: ["05085020400", "05085020500", "05085020600", "05085020700", "05085020800"] },
      "05093", "05095", "05107", "05111",
      { fips: "05117", tracts: ["05117460200", "05117460300"] },
      { fips: "05119", tracts: ["05119003900"] },
      { fips: "05121", tracts: ["05121960100", "05121960302"] },
      "05123", "05147",
      // Mississippi Delta
      "28011", "28027",
      { fips: "28033", tracts: ["28033070101"] },
      { fips: "28051", tracts: ["28051950300"] },
      "28053", "28055", "28083", "28119", "28125", "28133",
      { fips: "28135", tracts: ["28135950300", "28135950400"] },
      "28143",
      { fips: "28149", tracts: ["28149950101"] },
      "28151",
      { fips: "28163", tracts: ["28163950400"] },
    ],
  },
  {
    id: "appalachia",
    name: "Appalachia",
    desc: "John Alexander Williams' 'Consensus Appalachia' (1996/2002): counties in at least 5 of 6 classic definitions of the region",
    counties: [
      // Alabama
      "01009", "01015", "01019", "01043", "01049", "01055", "01071", "01073",
      "01095", "01115", "01117", "01121",
      // Georgia
      "13015", "13047", "13055", "13057", "13083", "13085", "13111", "13115",
      "13123", "13129", "13137", "13187", "13213", "13227", "13233", "13241",
      "13281", "13291", "13295", "13311", "13313",
      // Kentucky
      "21013", "21019", "21025", "21043", "21051", "21053", "21063", "21065",
      "21071", "21089", "21095", "21109", "21115", "21119", "21121", "21125",
      "21127", "21129", "21131", "21133", "21135", "21147", "21153", "21159",
      "21165", "21175", "21189", "21193", "21195", "21197", "21199", "21203",
      "21205", "21231", "21235", "21237",
      // North Carolina
      "37003", "37005", "37009", "37011", "37021", "37023", "37027", "37039",
      "37043", "37075", "37087", "37089", "37099", "37111", "37113", "37115",
      "37121", "37149", "37161", "37171", "37173", "37175", "37189", "37193",
      "37199",
      // South Carolina
      "45045", "45073", "45077",
      // Tennessee
      "47001", "47007", "47009", "47011", "47013", "47019", "47025", "47029",
      "47035", "47049", "47057", "47059", "47061", "47063", "47065", "47067",
      "47073", "47089", "47091", "47093", "47105", "47107", "47115", "47121",
      "47123", "47129", "47133", "47137", "47139", "47141", "47143", "47145",
      "47151", "47153", "47155", "47163", "47171", "47173", "47175", "47177",
      "47179", "47185",
      // Virginia (31 counties + 13 independent cities)
      "51005", "51015", "51017", "51021", "51023", "51027", "51035", "51043",
      "51045", "51051", "51063", "51069", "51071", "51077", "51091", "51105",
      "51121", "51139", "51155", "51161", "51163", "51165", "51167", "51169",
      "51171", "51173", "51185", "51187", "51191", "51195", "51197",
      "51520", "51530", "51580", "51640", "51660", "51678", "51720", "51750",
      "51770", "51775", "51790", "51820", "51840",
      // West Virginia (44 of 55 counties — excludes the Northern Panhandle
      // and Ohio Valley counties)
      "54001", "54003", "54005", "54007", "54011", "54013", "54015", "54017",
      "54019", "54021", "54023", "54025", "54027", "54031", "54033", "54037",
      "54039", "54041", "54043", "54045", "54047", "54049", "54055", "54057",
      "54059", "54061", "54063", "54065", "54067", "54071", "54075", "54077",
      "54081", "54083", "54085", "54087", "54089", "54091", "54093", "54097",
      "54099", "54101", "54105", "54109",
    ],
  },

  // --- Pipe dreams ---
  {
    id: "staten-island",
    name: "New Jersey",
    label: "Staten Island (to NJ)",
    desc: "Staten Island voted to secede from NYC in 1993; the running joke is giving it to New Jersey instead",
    states: ["34"],
    counties: ["36085"],
  },
  {
    id: "dc-maryland",
    name: "Maryland",
    label: "DC (back to Maryland)",
    desc: "Retrocedes DC to Maryland, which ceded the land in 1791 — unlike Virginia's share, it was never taken back",
    states: ["24"],
    counties: ["11001"],
  },
];

// The preset's whole counties, by FIPS. Partial counties (see
// partialCounties) are carved separately, so they're left out here.
export function resolvePreset(preset, countiesById) {
  const set = new Set((preset.counties ?? []).filter((c) => typeof c === "string"));
  if (preset.states) {
    for (const [fips, c] of Object.entries(countiesById)) {
      if (preset.states.includes(c.st)) set.add(fips);
    }
  }
  for (const fips of preset.exclude ?? []) set.delete(fips);
  return [...set];
}

// The preset's partial counties: { fips, tracts } entries naming the tract
// GEOIDs the preset claims out of that county.
export function partialCounties(preset) {
  return (preset.counties ?? []).filter((c) => typeof c !== "string");
}
