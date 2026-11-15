const names = ["inventory", "agents", "outcomes"];
export function selectTab(name) {
  for (const id of names) {
    const tab = document.getElementById(`tab-${id}`);
    tab.setAttribute("aria-selected", String(id === name));
    tab.tabIndex = id === name ? 0 : -1;
    document.getElementById(`view-${id}`).hidden = id !== name;
  }
}
for (const [index, name] of names.entries()) {
  const tab = document.getElementById(`tab-${name}`);
  tab.onclick = () => selectTab(name);
  tab.onkeydown = event => {
    const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!offset && !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? names.length - 1 : (index + offset + names.length) % names.length;
    selectTab(names[next]);
    document.getElementById(`tab-${names[next]}`).focus();
  };
}
