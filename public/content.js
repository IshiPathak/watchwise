
(() => {
  if (window.__watchwiseV2) return;
  window.__watchwiseV2 = true;

  const ROOT_ID = "watchwise-root";
  const ROW_SELECTOR = "ytd-playlist-video-renderer";
  const collectedVideos = new Map();

  let categories = [];
  let activeCategory = "all";
  let scanning = false;

  // Common words that do not help identify video topics.
  const STOP_WORDS = new Set(`
    the and for with from into about your this that what when
    where why how are was were you all can will just have has
    its our their they them then than but not now new best
    full complete official tutorial course guide video videos
    watch part episode beginner beginners advanced explained
    learn learning introduction shorts short make made using
    everything something really very more most only also
    my me i we he she it a an to of in on at by as is be
    do did does if or so up out over after before
  `.split(/\s+/));

  const wait = (ms) =>
    new Promise(resolve => setTimeout(resolve, ms));

  function getPlaylistContents() {
    return document.querySelector(
      "ytd-playlist-video-list-renderer #contents"
    );
  }

  function getVideoId(href) {
    try {
      const url = new URL(href, location.origin);

      return url.searchParams.get("v") ||
        url.pathname.match(/\/shorts\/([^/?]+)/)?.[1] ||
        null;
    } catch {
      return null;
    }
  }

  // Collect titles and thumbnails only.
  function collectVisibleVideos() {
    const rows = document.querySelectorAll(ROW_SELECTOR);
    let added = 0;

    rows.forEach(row => {
      const link = row.querySelector("a#video-title");
      if (!link) return;

      const title = (
        link.textContent ||
        link.getAttribute("title") ||
        ""
      ).replace(/\s+/g, " ").trim();

      const id = getVideoId(link.href);

      if (!id || !title || collectedVideos.has(id)) return;

      const thumbnail = row.querySelector(
        "ytd-thumbnail img"
      )?.src || "";

      const duration = row.querySelector(
        "ytd-thumbnail-overlay-time-status-renderer"
      )?.textContent?.trim() || "";

      collectedVideos.set(id, {
        id,
        title,
        url: link.href,
        thumbnail,
        duration
      });

      added++;
    });

    return added;
  }

  // Convert a title into useful words.
  function tokenize(title) {
    return title
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^\p{L}\p{N}+# ]/gu, " ")
      .split(/\s+/)
      .filter(word =>
        word.length > 2 &&
        !STOP_WORDS.has(word) &&
        !/^\d+$/.test(word)
      );
  }

  function cosine(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (const value of a.values()) {
      normA += value * value;
    }

    for (const value of b.values()) {
      normB += value * value;
    }

    for (const [word, value] of a) {
      dot += value * (b.get(word) || 0);
    }

    if (!normA || !normB) return 0;

    return dot / Math.sqrt(normA * normB);
  }

  function normalize(vector) {
    let length = 0;

    for (const value of vector.values()) {
      length += value * value;
    }

    length = Math.sqrt(length);

    if (!length) return vector;

    for (const [word, value] of vector) {
      vector.set(word, value / length);
    }

    return vector;
  }

  function makeCentroid(documents, assignments, cluster) {
    const centroid = new Map();
    let count = 0;

    documents.forEach((doc, index) => {
      if (assignments[index] !== cluster) return;

      count++;

      for (const [word, value] of doc.vector) {
        centroid.set(
          word,
          (centroid.get(word) || 0) + value
        );
      }
    });

    if (!count) return centroid;

    for (const [word, value] of centroid) {
      centroid.set(word, value / count);
    }

    return normalize(centroid);
  }

  // Discover broad groups from the actual playlist.
  function discoverTopics(videos) {
    const documents = videos.map(video => ({
      video,
      tokens: tokenize(video.title),
      vector: new Map()
    }));

    const documentFrequency = new Map();

    documents.forEach(doc => {
      for (const word of new Set(doc.tokens)) {
        documentFrequency.set(
          word,
          (documentFrequency.get(word) || 0) + 1
        );
      }
    });

    const minFrequency = Math.max(
      2,
      Math.ceil(documents.length * 0.01)
    );

    const vocabulary = new Set(
      [...documentFrequency.entries()]
        .filter(([, frequency]) => frequency >= minFrequency)
        .map(([word]) => word)
    );

    documents.forEach(doc => {
      const frequencies = new Map();

      for (const word of doc.tokens) {
        if (vocabulary.has(word)) {
          frequencies.set(
            word,
            (frequencies.get(word) || 0) + 1
          );
        }
      }

      for (const [word, count] of frequencies) {
        const idf = Math.log(
          1 + documents.length /
          (1 + documentFrequency.get(word))
        );

        doc.vector.set(word, (1 + Math.log(count)) * idf);
      }

      normalize(doc.vector);
    });

    // If there is too little useful text, avoid inventing topics.
    const usefulDocs = documents.filter(
      doc => doc.vector.size > 0
    );

    if (usefulDocs.length < 8) {
      return [{
        name: "All videos",
        videos
      }];
    }

    const k = Math.min(
      8,
      Math.max(5, Math.round(videos.length / 80) + 4),
      Math.floor(usefulDocs.length / 3)
    );

    // Deterministic farthest-first initialization.
    const centroids = [usefulDocs[0].vector];

    while (centroids.length < k) {
      let bestDoc = null;
      let bestDistance = -1;

      for (const doc of usefulDocs) {
        const nearest = Math.max(
          ...centroids.map(center => cosine(doc.vector, center))
        );

        const distance = 1 - nearest;

        if (distance > bestDistance) {
          bestDistance = distance;
          bestDoc = doc;
        }
      }

      if (!bestDoc) break;
      centroids.push(bestDoc.vector);
    }

    let assignments = new Array(usefulDocs.length).fill(-1);

    // Spherical k-means.
    for (let iteration = 0; iteration < 18; iteration++) {
      let changed = false;

      usefulDocs.forEach((doc, index) => {
        let bestCluster = 0;
        let bestScore = -1;

        centroids.forEach((center, cluster) => {
          const score = cosine(doc.vector, center);

          if (score > bestScore) {
            bestScore = score;
            bestCluster = cluster;
          }
        });

        if (assignments[index] !== bestCluster) {
          assignments[index] = bestCluster;
          changed = true;
        }
      });

      for (let cluster = 0; cluster < centroids.length; cluster++) {
        const centroid = makeCentroid(
          usefulDocs,
          assignments,
          cluster
        );

        if (centroid.size) {
          centroids[cluster] = centroid;
        }
      }

      if (!changed) break;
    }

    // Build readable labels from repeated terms.
    const groups = [];

    for (let cluster = 0; cluster < centroids.length; cluster++) {
      const members = usefulDocs.filter(
        (_, index) => assignments[index] === cluster
      );

      if (members.length < 3) continue;

      const termScores = new Map();
      const termCounts = new Map();

      members.forEach(doc => {
        for (const [word, value] of doc.vector) {
          termScores.set(
            word,
            (termScores.get(word) || 0) + value
          );

          termCounts.set(
            word,
            (termCounts.get(word) || 0) + 1
          );
        }
      });

      const keywords = [...termScores.entries()]
        .filter(([word]) => termCounts.get(word) >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([word]) =>
          word.charAt(0).toUpperCase() + word.slice(1)
        );

      const name = keywords.length
        ? keywords.join(" & ")
        : "Other topics";

      groups.push({
        name,
        videos: members.map(doc => doc.video)
      });
    }

    // Titles with insufficient useful words go into Other.
    const assignedIds = new Set(
      groups.flatMap(group => group.videos.map(video => video.id))
    );

    const unassigned = videos.filter(
      video => !assignedIds.has(video.id)
    );

    if (unassigned.length) {
      groups.push({
        name: "Other",
        videos: unassigned
      });
    }

    return groups.sort(
      (a, b) => b.videos.length - a.videos.length
    );
  }

  function createInterface() {
    const existing = document.getElementById(ROOT_ID);
    if (existing) return existing;

    const root = document.createElement("section");
    root.id = ROOT_ID;

    root.innerHTML = `
      <div class="ww-heading">
        <div>
          <h2>WatchWise</h2>
          <p class="ww-status">Ready to organize your playlist.</p>
        </div>
        <button class="ww-scan" type="button">
          Scan playlist
        </button>
      </div>

      <div class="ww-filters"></div>
      <div class="ww-grid"></div>
    `;

    const contents = getPlaylistContents();

    if (contents) {
      contents.parentElement.insertBefore(root, contents);
    }

    root.querySelector(".ww-scan").addEventListener(
      "click",
      scanPlaylist
    );

    return root;
  }

  function renderResults() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    const filters = root.querySelector(".ww-filters");
    const grid = root.querySelector(".ww-grid");

    filters.replaceChildren();
    grid.replaceChildren();

    const allButton = makeChip(
      `All (${collectedVideos.size})`,
      "all"
    );

    filters.appendChild(allButton);

    categories.forEach(category => {
      filters.appendChild(
        makeChip(
          `${category.name} (${category.videos.length})`,
          category.name
        )
      );
    });

    const selectedVideos = activeCategory === "all"
      ? [...collectedVideos.values()]
      : categories.find(
          category => category.name === activeCategory
        )?.videos || [];

    selectedVideos.forEach(video => {
      const card = document.createElement("a");
      card.className = "ww-card";
      card.href = video.url;
      card.title = video.title;

      const image = document.createElement("img");
      image.className = "ww-thumbnail";
      image.alt = "";
      image.loading = "lazy";
      image.src = video.thumbnail;

      const title = document.createElement("h3");
      title.textContent = video.title;

      card.append(image, title);

      if (video.duration) {
        const duration = document.createElement("span");
        duration.className = "ww-duration";
        duration.textContent = video.duration;
        card.appendChild(duration);
      }

      grid.appendChild(card);
    });

    root.querySelector(".ww-status").textContent =
      `${selectedVideos.length} videos · ${categories.length} discovered topics`;
  }

  function makeChip(label, category) {
    const button = document.createElement("button");

    button.type = "button";
    button.className = "ww-chip";
    button.textContent = label;

    if (activeCategory === category) {
      button.classList.add("ww-active");
    }

    button.setAttribute(
      "aria-pressed",
      String(activeCategory === category)
    );

    button.addEventListener("click", () => {
      // Only change the local view. Never scan YouTube here.
      activeCategory = category;
      renderResults();
    });

    return button;
  }

  async function scanPlaylist() {
    if (scanning) return;

    const root = document.getElementById(ROOT_ID);
    const contents = getPlaylistContents();

    if (!root || !contents) return;

    scanning = true;

    const button = root.querySelector(".ww-scan");
    const status = root.querySelector(".ww-status");

    button.disabled = true;
    button.textContent = "Scanning...";

    const originalScroll = window.scrollY;
    let unchangedRounds = 0;
    let rounds = 0;

    try {
      // Keep collecting as YouTube loads additional playlist rows.
      while (rounds < 300 && unchangedRounds < 8) {
        const added = collectVisibleVideos();

        unchangedRounds = added
          ? 0
          : unchangedRounds + 1;

        status.textContent =
          `Collecting videos... ${collectedVideos.size} found`;

        const atBottom =
          window.innerHeight + window.scrollY >=
          document.documentElement.scrollHeight - 150;

        if (atBottom && unchangedRounds >= 3) break;

        window.scrollBy({
          top: Math.max(500, window.innerHeight * 0.75),
          behavior: "instant"
        });

        await wait(400);
        rounds++;
      }

      collectVisibleVideos();

      const videos = [...collectedVideos.values()];

      if (videos.length < 8) {
        status.textContent =
          `Only ${videos.length} videos collected. Scroll and try again.`;
        return;
      }

      status.textContent = "Discovering topics...";

      categories = discoverTopics(videos);
      activeCategory = "all";

      // Hide the native list only after collection is complete.
      contents.classList.add("ww-native-hidden");

      renderResults();

      button.textContent = "Scan again";
      status.textContent =
        `${videos.length} videos organized into ${categories.length} topics`;
    } catch (error) {
      console.error("WatchWise scan error:", error);
      status.textContent = "Scan failed. Check the browser console.";
    } finally {
      window.scrollTo(0, originalScroll);
      scanning = false;
      button.disabled = false;

      if (button.textContent === "Scanning...") {
        button.textContent = "Try again";
      }
    }
  }

  function initialize() {
    if (
      new URLSearchParams(location.search).get("list") !== "WL"
    ) return;

    if (!getPlaylistContents()) return;

    createInterface();
  }

  // Initialize after YouTube has rendered the playlist.
  initialize();

  let previousUrl = location.href;

  setInterval(() => {
    if (location.href === previousUrl) return;

    previousUrl = location.href;

    collectedVideos.clear();
    categories = [];
    activeCategory = "all";

    document.getElementById(ROOT_ID)?.remove();

    document.querySelectorAll(".ww-native-hidden").forEach(element => {
      element.classList.remove("ww-native-hidden");
    });

    initialize();
  }, 700);
})();
