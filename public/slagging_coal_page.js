const res = await fetch("/aft_model.json");
const json = await res.json();
window.model = mlRandomForest.RandomForestRegression.load(json);
console.log("✅ Model ready");
