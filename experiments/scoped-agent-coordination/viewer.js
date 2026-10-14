const names = {
  builder: "Builder / WI-1",
  console: "Console / WI-2",
  docs: "Documentation / WI-7",
  "red-team": "Independent red team / REVIEW-1"
};
const descriptions = {
  builder: "Given implementation-specific context and evidence-policy v1.",
  console: "Given review-UX context and evidence-policy v1, without implementation details.",
  docs: "Given only its identity-label decision, unrelated to evidence policy.",
  "red-team": "Given evidence-policy v2 and redacted verification criteria. Can challenge, not approve."
};
function paragraph(text, className) {
  const p = document.createElement("p");
  p.textContent = text;
  if (className) p.className = className;
  return p;
}
function drawCard(result) {
  const card = document.createElement("article");
  card.className = "card";
  const label = document.createElement("small");
  label.textContent = names[result.actor] ?? result.actor;
  const title = document.createElement("h3");
  title.textContent = (result.status ?? "unknown").replaceAll("-", " ");
  title.className = "status " + (result.status ?? "unknown-blocked");
  card.append(label, title, paragraph(descriptions[result.actor] ?? ""), 
    paragraph(result.affectedFacets?.length
      ? "Changed dependencies: " + result.affectedFacets.join(", ")
      : "No relevant changed dependency.", "meta"),
    paragraph(result.claimsConflict
      ? "Self-reported claim disagrees with current governing decision."
      : "No conflicting claim established.", "meta"),
    paragraph("Trusted executed test: " + (result.trustedExecutedTest ? "present" : "not presented"), "meta"));
  return card;
}
async function load() {
  const target = document.querySelector("#cards");
  try {
    const response = await fetch("./run-output/report.json");
    if (!response.ok) throw Error("HTTP " + response.status);
    const report = await response.json();
    const count = report.results.filter(r => r.status === "revalidation-required").length;
    document.querySelector("#summary").textContent =
      count + " need revalidation / " + report.results.length + " participants";
    target.replaceChildren(...report.results.map(drawCard));
  } catch (error) {
    target.replaceChildren(paragraph(
      "No local report found. Run: node proof.mjs simulate, then start a static HTTP server in this directory. " + error.message,
      "error"));
  }
}
load();
