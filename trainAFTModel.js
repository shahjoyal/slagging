const fs = require("fs");
const csv = require("csv-parser");
const { RandomForestRegression } = require("ml-random-forest");

const X = [];
const Y = [];

fs.createReadStream("aft_training_data.csv")
  .pipe(csv())
  .on("data", (row) => {
    X.push([
      parseFloat(row.SiO2),
      parseFloat(row.Al2O3),
      parseFloat(row.Fe2O3),
      parseFloat(row.CaO),
      parseFloat(row.MgO),
      parseFloat(row.Na2O),
      parseFloat(row.K2O),
      parseFloat(row.SO3),
      parseFloat(row.TiO2),
    ]);

    Y.push(parseFloat(row.AFT));
  })
  .on("end", () => {
    const model = new RandomForestRegression({
      nEstimators: 200,
      maxFeatures: 0.8,
      replacement: true,
      seed: 42,
    });

    model.train(X, Y);

    fs.writeFileSync("aft_model.json", JSON.stringify(model.toJSON()));
    console.log("AI model trained and saved as aft_model.json");
  });
