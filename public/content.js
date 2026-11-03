
(() => {
  // Run only on the actual Watch Later playlist.
  if (location.hostname !== "www.youtube.com" &&
      location.hostname !== "youtube.com") return;



  const ROOT_ID = "watchwise-root";
  const STOP_WORDS = new Set(
    `a an the and or but to of in on for with from by at as is are
     was were be been being it its this that these those i you your
     we our they their he she his her how what why when where who
     which learn tutorial course guide introduction beginner beginners
     advanced complete full official explained shorts video videos
     part episode new best top easy simple ultimate updated 2024 2025
     2026 watch make made using about into over all`.split(/\s+/)
  );

  let selectedTopic = "all";
  let refreshQueued = false;

  function getVideoRows() {
    return [...document.querySelectorAll("ytd-playlist-video-renderer")]
      .filter((row) =>
        row.querySelector("#video-title") &&
        row.isConnected
      );
  }

  function getTitle(row) {
    return row.querySelector("#video-title")?.textContent
      ?.replace(/\s+/g, " ")
      .trim() || "";
  }

  function getChannel(row) {
    return row.querySelector("#channel-name")?.textContent
      ?.replace(/\s+/g, " ")
      .trim() || "";
  }

  function getWords(text) {
    return text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^\p{L}\p{N}+#. ]/gu, " ")
      .split(/\s+/)
      .filter((word) =>
        word.length > 2 &&
        !STOP_WORDS.has(word) &&
        !/^\d+$/.test(word)
      );
  }

  function getTopic(row) {
    const title = getTitle(row);
    const channel = getChannel(row);

    // Titles carry more weight than channel names.
    const words = getWords(title);
    const counts = new Map();

    for (const word of words) {
      counts.set(word, (counts.get(word) || 0) + 2);
    }

    for (const word of getWords(channel)) {
      counts.set(word, (counts.get(word) || 0) + 1);
    }

    // A title with no useful words can remain uncategorized.
    if (counts.size === 0) return "Uncategorized";

    // Choose the strongest locally detected keyword.
    const ranked = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] ||
        words.indexOf(a[0]) - words.indexOf(b[0]) ||
        a[0].localeCompare(b[0])
    );

    const keyword = ranked[0][0];
    return keyword.charAt(0).toUpperCase() + keyword.slice(1);
  }

  function createInterface() {
    let root = document.getElementById(ROOT_ID);

    if (root) return root;

    root = document.createElement("section");
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="ww-heading">
        <div>
          <span class="ww-eyebrow">YOUR PERSONAL VIDEO ORGANIZER</span>
          <h2>WatchWise</h2>
          <p class="ww-description">
            Topics are discovered from your video titles on this device.
          </p>
        </div>
        <span class="ww-count" aria-live="polite"></span>
      </div>
      <div class="ww-filters" aria-label="Filter videos by topic"></div>
      <p class="ww-note"></p>
    `;

    const playlist = document.querySelector(
      "ytd-playlist-video-list-renderer"
    );

    if (playlist) {
      playlist.parentElement.insertBefore(root, playlist);
    }

    return root;
  }

  function render() {
    if (new URLSearchParams(location.search).get("list") !== "WL") {
    document.getElementById(ROOT_ID)?.remove();

    for (const row of getVideoRows()) {
        row.hidden = false;
        row.classList.remove("ww-hidden");
    }

    return;
    }

    const rows = getVideoRows();
    if (!rows.length) return;

    const root = createInterface();

    // Recheck in case YouTube has not rendered the playlist container yet.
    if (!root.isConnected) return;

    const topicByRow = new Map();
    const topicCounts = new Map();

    for (const row of rows) {
      const topic = getTopic(row);
      topicByRow.set(row, topic);
      topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    }

    const topics = [...topicCounts.keys()].sort((a, b) =>
      a.localeCompare(b)
    );

    const availableTopics = ["all", ...topics];

    if (!availableTopics.includes(selectedTopic)) {
      selectedTopic = "all";
    }

    const filters = root.querySelector(".ww-filters");

    filters.replaceChildren();

    for (const topic of availableTopics) {
      const button = document.createElement("button");
      const isAll = topic === "all";
      const label = isAll
        ? `All (${rows.length})`
        : `${topic} (${topicCounts.get(topic)})`;

      button.type = "button";
      button.textContent = label;
      button.className = "ww-chip";
      button.setAttribute(
        "aria-pressed",
        String(selectedTopic === topic)
      );

      if (selectedTopic === topic) {
        button.classList.add("ww-active");
      }

      button.addEventListener("click", () => {
        selectedTopic = topic;
        render();
      });

      filters.appendChild(button);
    }

    let visible = 0;

    for (const row of rows) {
      const matches = selectedTopic === "all" ||
        topicByRow.get(row) === selectedTopic;

      row.hidden = !matches;
      row.classList.toggle("ww-hidden", !matches);

      if (matches) visible++;
    }

    root.querySelector(".ww-count").textContent =
      `${visible} of ${rows.length} loaded videos`;

    root.querySelector(".ww-note").textContent =
      "Categories are automatic keyword guesses, not AI-generated labels. " +
      "YouTube may load additional videos as you scroll.";
  }

  function scheduleRender() {
    if (refreshQueued) return;

    refreshQueued = true;

    requestAnimationFrame(() => {
      refreshQueued = false;
      render();
    });
  }

  // YouTube dynamically replaces and loads playlist rows.
  const observer = new MutationObserver((records) => {
  const root = document.getElementById(ROOT_ID);

  const pageChanged = records.some(
    (record) => !root || !root.contains(record.target)
  );

  if (pageChanged) {
    scheduleRender();
  }
});

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // Support YouTube's single-page navigation.
  let previousUrl = location.href;

  setInterval(() => {
    if (location.href !== previousUrl) {
      previousUrl = location.href;
      selectedTopic = "all";

      if (new URLSearchParams(location.search).get("list") === "WL") {
        scheduleRender();
      } else {
        document.getElementById(ROOT_ID)?.remove();

        for (const row of getVideoRows()) {
          row.hidden = false;
          row.classList.remove("ww-hidden");
        }
      }
    }
  }, 800);

  scheduleRender();
})();
