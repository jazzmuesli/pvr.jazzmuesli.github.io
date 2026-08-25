const url = "https://api.energy-charts.info/price?start=2023-01-01&end=2023-01-05";
const r = await fetch(url);
console.log("status", r.status);
const j = await r.json();
console.log("keys", Object.keys(j));
console.log("sample", JSON.stringify(j).slice(0, 400));
