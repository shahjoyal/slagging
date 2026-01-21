const fs = require("fs");
const csv = require("csv-parser");
const { RandomForestRegression } = require("ml-random-forest");


const X = [];
const Y = [];


function formulaAFT(values) {
  const [SiO2, Al2O3, Fe2O3, CaO, MgO, Na2O, K2O, SO3, TiO2] = values;
  const sumSiAl = SiO2 + Al2O3;

  if (sumSiAl < 55) {
    return 1245 +
      1.1 * SiO2 +
      0.95 * Al2O3 -
      2.5 * Fe2O3 -
      2.98 * CaO -
      4.5 * MgO -
      7.89 * (Na2O + K2O) -
      1.7 * SO3 -
      0.63 * TiO2;
  } else if (sumSiAl < 75) {
    return 1323 +
      1.45 * SiO2 +
      0.683 * Al2O3 -
      2.39 * Fe2O3 -
      3.1 * CaO -
      4.5 * MgO -
      7.49 * (Na2O + K2O) -
      2.1 * SO3 -
      0.63 * TiO2;
  } else {
    return 1395 +
      1.2 * SiO2 +
      0.9 * Al2O3 -
      2.5 * Fe2O3 -
      3.1 * CaO -
      4.5 * MgO -
      7.2 * (Na2O + K2O) -
      1.7 * SO3 -
      0.63 * TiO2;
  }
}


function buildFeatures(values) {
  const [
    SiO2,
    Al2O3,
    Fe2O3,
    CaO,
    MgO,
    Na2O,
    K2O,
    SO3,
    TiO2,
  ] = values;

  const SiAl = SiO2 + 0.8 * Al2O3;   
  const Flux = CaO + MgO + Fe2O3;    
  const Alk  = Na2O + K2O;            

  return [
    SiAl,
    Flux,
    Alk,
    SO3,
    TiO2,
  ];
}


fs.createReadStream("aft_training_data1.csv")
  .pipe(csv())
  .on("data", (row) => {

    const oxides = [
      parseFloat(row.SiO2),
      parseFloat(row.Al2O3),
      parseFloat(row.Fe2O3),
      parseFloat(row.CaO),
      parseFloat(row.MgO),
      parseFloat(row.Na2O),
      parseFloat(row.K2O),
      parseFloat(row.SO3),
      parseFloat(row.TiO2),
    ];

    const aftActual = parseFloat(row.AFT);

    if (oxides.some(v => Number.isNaN(v)) || Number.isNaN(aftActual)) return;

    const aftBase = formulaAFT(oxides);
    const residual = aftActual - aftBase;

    X.push(buildFeatures(oxides));  
    Y.push(residual);               
  })
  .on("end", () => {
    console.log(`Training on ${X.length} samples (Step 3)`);

    const model = new RandomForestRegression({
      nEstimators: 100000,
      maxFeatures: Math.floor(Math.sqrt(X[0].length)),
      maxDepth: 14,
      minNumSamples: 4,
      replacement: true,
      seed: 42,
    });

    model.train(X, Y);

    fs.writeFileSync(
      "aft_model.json",
      JSON.stringify(model.toJSON())
    );

    console.log("model trained and saved (aft_model.json)");
  });
