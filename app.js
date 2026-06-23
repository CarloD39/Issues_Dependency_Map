
    const el = (id) => document.getElementById(id);
    const statusEl = el("status");
    const nodesCountEl = el("nodesCount");
    const linksCountEl = el("linksCount");
    const legendEl = el("legend");
    const container = el("network");

    let network = null;
    let currentAbortController = null;
    let iterationSearchAbortController = null;
    let physicsEnabled = true;
    let currentGraph = { nodes: [], edges: [] };

    const selectedIterationLabels = new Map();

    const palette = ["#7aa2ff","#6dd6a1","#ffb86b","#c792ea","#ff7a7a","#7bdff2","#b8f27c","#f7a6ff","#ffdf6b","#9bb1ff"];

    const EPIC_GROUP_PATH = "zuru.tech/dreamcatcher";

    const TEMPORAL_COLORS = {
      current: "#3b82f6",              // issue nella/e iteration selezionata/e
      past: "#f59e0b",                 // issue in iteration precedente
      overlap: "#14b8a6",              // issue in altra iteration(quindi altro team) sovrapposta temporalmente
      future: "#a855f7",               // issue in iteration futura
      unplanned_same_team: "#ef4444",  // issue stesso team senza iteration
      none_external: "#6b7280"         // issue esterna senza iteration / non classificata
    };

    const TEMPORAL_LABELS = {
      current: "Current iteration",
      past: "Past iteration",
      overlap: "Overlapping iteration",
      future: "Future iteration",
      unplanned_same_team: "No Iteration - same team",
      none_external: "No iteration / external"
    };

    function setStatus(msg, isError = false) {
      statusEl.textContent = msg;
      statusEl.style.borderColor = isError ? "rgba(255,122,122,.35)" : "rgba(122,162,255,.28)";
      statusEl.style.background = isError ? "rgba(255,122,122,.08)" : "rgba(122,162,255,.08)";
      statusEl.style.color = isError ? "#ffd7d7" : "var(--muted)";
    }

    function escapeHtml(str) {
      return String(str ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function parseIterationIds() {
      return el("iterationIds").value.split(",").map(x => x.trim()).filter(Boolean);
    }

    function parseEpicIds() {
      return el("epicIds").value.split(",").map(x => x.trim()).filter(Boolean);
    }

    function hasPlannedLabel(labels = []) {
      return labels.some(
        label => label.toLowerCase() === "scheduling::planned"
      );
    }

    function getTeamLabels(labels = []) {
      // Team ownership rule:
      // il team è identificato SOLO da label che iniziano con "team::",
      // ad esempio: "team::BIM Echo".
      return labels
        .map(label => String(label).trim().toLowerCase())
        .filter(label => label.startsWith("team::"));
    }

    function hasAnySameTeamLabel(labels = [], selectedTeamLabels = new Set()) {
      if (!selectedTeamLabels.size) return false;
      return getTeamLabels(labels).some(label => selectedTeamLabels.has(label));
    }

    function getLabelName(label) {
      if (typeof label === "string") return label;

      return (
        label?.name ||
        label?.title ||
        label?.label ||
        ""
      );
    }

    function hasQaPassedLabel(labels = []) {
        return labels.some(label => {
          const normalized = String(label)
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "");

        return (
          normalized === "status::qa::passed" ||
          normalized === "status::qapassed" ||
          normalized.includes("status::qa::passed") ||
          normalized.includes("status::qapassed")
        );
      });
    }

    function parseDateOnly(value) {
      if (!value) return null;
      const d = new Date(`${value}T00:00:00`);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    function classifyTemporalStatus(issue, selectedWindows, selectedTeamLabels) {
      if (!issue.external) return "current";

      const selectedIds = new Set(selectedWindows.map(w => String(w.id)));
      if (issue.iterationId && selectedIds.has(String(issue.iterationId))) {
        return "current";
      }

      const issueStart = parseDateOnly(issue.iterationStartDate);
      const issueDue = parseDateOnly(issue.iterationDueDate);

      if (!issueStart || !issueDue) {
        return hasAnySameTeamLabel(issue.labels, selectedTeamLabels)
          ? "unplanned_same_team"
          : "none_external";
      }

      const validWindows = selectedWindows
        .map(w => ({ start: parseDateOnly(w.start), due: parseDateOnly(w.due) }))
        .filter(w => w.start && w.due);

      if (!validWindows.length) return "none_external";

      const earliestSelectedStart = new Date(Math.min(...validWindows.map(w => w.start.getTime())));
      const latestSelectedDue = new Date(Math.max(...validWindows.map(w => w.due.getTime())));

      if (issueDue < earliestSelectedStart) return "past";
      if (issueStart > latestSelectedDue) return "future";
      return "overlap";
    }

    function getTemporalColor(status) {
      return TEMPORAL_COLORS[status] || TEMPORAL_COLORS.none_external;
    }

    async function fetchIssueDetails(gitlabUrl, projectId, issueIid, signal) {
      const issueUrl = `${gitlabUrl}/api/v4/projects/${encodeURIComponent(projectId)}/issues/${issueIid}`;
      const res = await gitlabFetch(issueUrl, signal);
      return await res.json();
    }

    function buildParentUrl(gitlabUrl, parentInfo) {
      if (!parentInfo?.iid) return null;

      return `${gitlabUrl}/groups/zuru.tech/dreamcatcher/-/epics/${parentInfo.iid}`;
    }

    function extractParentInfo(issue, gitlabUrl) {
      const epic = issue?.epic || null;
      const parent = issue?.parent || null;

      const id =
        epic?.id ??
        parent?.id ??
        issue?.parent_id ??
        issue?.parent_iid ??
        null;

      if (!id) return null;

      const info = {
        id: String(id),
        iid: epic?.iid ?? parent?.iid ?? issue?.parent_iid ?? null,
        title: epic?.title || parent?.title || issue?.parent_title || `Parent ${id}`,
        url: epic?.web_url || parent?.web_url || issue?.parent_web_url || null,
        labels: epic?.labels || parent?.labels || issue?.parent_labels || []
      };

      info.url =
        epic?.web_url ||
        parent?.web_url ||
        issue?.parent_web_url ||
        buildParentUrl(gitlabUrl, info);

      return info;
    }

    async function enrichParentInfo(gitlabUrl, parentInfo, cache, signal) {
      if (!parentInfo) return null;

      const cacheKey = parentInfo.iid || parentInfo.id;
      if (cache.has(cacheKey)) return cache.get(cacheKey);

      if (!parentInfo.iid) {
        cache.set(cacheKey, parentInfo);
        return parentInfo;
      }

      try {
        const encodedGroup = encodeURIComponent(EPIC_GROUP_PATH);
        const url = `${gitlabUrl}/api/v4/groups/${encodedGroup}/epics/${parentInfo.iid}`;
        const res = await gitlabFetch(url, signal);
        const epicDetails = await res.json();

        const enriched = {
          ...parentInfo,
          title: epicDetails.title || parentInfo.title,
          url: epicDetails.web_url || parentInfo.url,
          labels: epicDetails.labels || parentInfo.labels || []
        };

        cache.set(cacheKey, enriched);
        return enriched;
      } catch (err) {
        console.warn("Impossibile recuperare dettagli parent/epic", parentInfo, err);
        cache.set(cacheKey, parentInfo);
        return parentInfo;
      }
    }

    function parentNodeId(parentId) {
      return `parent_${parentId}`;
    }

    function buildParentNodesAndEdges(issueValues, parentMode = "show_all", selectedEpicIds = []) {
      if (parentMode === "hide_all") {
        return {
          parentNodes: [],
          parentEdges: []
        };
      }

      const parentMap = new Map();
      const parentEdges = [];

      for (const issue of issueValues) {
        if (!issue.parentId) continue;

        const parentHasQaPassed =
          hasQaPassedLabel(issue.parentLabels || []);

          console.log(
            "PARENT FILTER",
            issue.parentTitle,
            issue.parentLabels,
            "hasQaPassed:",
            parentHasQaPassed
        );

        if (
          parentMode === "hide_qa_passed" &&
          parentHasQaPassed
        ) {
          continue;
        }

        if (!parentMap.has(issue.parentId)) {
          const parentLabelId = issue.parentIid ? `#${issue.parentIid}` : `#${issue.parentId}`;
          const isSelectedEpic =
          selectedEpicIds.map(String).includes(String(issue.parentIid));

          const parentBorderColor = isSelectedEpic ? "#7aa2ff" : "#b388ff";
          const parentBackground = isSelectedEpic
            ? "rgba(122,162,255,0.26)"
            : "rgba(179,136,255,0.14)";
          const parentBorderWidth = isSelectedEpic ? 4 : 2;
          parentMap.set(issue.parentId, {
            id: parentNodeId(issue.parentId),
            label: `${isSelectedEpic ? "SELECTED EPIC" : "EPIC"} ${parentLabelId}\n${truncate(issue.parentTitle || "Parent", 34)}`,
            shape: "box",
            color: {
              background: parentBackground,
              border: parentBorderColor,
              highlight: {
                background: "rgba(179,136,255,0.22)",
                border: "#ffffff"
              },
              hover: {
                background: "rgba(179,136,255,0.20)",
                border: "#ffffff"
              }
            },
            font: {
              color: "#f3e8ff",
              size: 15,
              face: "Inter",
              bold: true
            },
            borderWidth: parentBorderWidth,
            margin: 12,
            shadow: {
              enabled: true,
              color: "rgba(0,0,0,.28)",
              size: 12,
              x: 0,
              y: 5
            },
            title: [
              `Parent / Epic: ${issue.parentTitle || "Parent"}`,
              `ID: ${issue.parentId}`,
              issue.parentUrl ? `URL: ${issue.parentUrl}` : ""
            ].filter(Boolean).join("\n"),
            webUrl: issue.parentUrl || null,
            isParentNode: true
          });
        }

        parentEdges.push({
          id: `belongs_${issue.id}`,
          from: parentNodeId(issue.parentId),
          to: issue.id,
          arrows: "",
          dashes: true,
          color: {
            color: "#8b8fa3",
            opacity: 0.55
          },
          width: 1,
          physics: false,
          smooth: {
            enabled: true,
            type: "continuous"
          },
          title: "belongs to parent"
        });
      }

      return {
        parentNodes: Array.from(parentMap.values()),
        parentEdges
      };
    }

    function issueKey(issue) {
      return issue.references?.full || `${issue.project_id}#${issue.iid}`;
    }

    function headers() {
      return { "PRIVATE-TOKEN": el("token").value.trim() };
    }

    async function gitlabFetch(url, signal) {
      const res = await fetch(url, {
        headers: headers(),
        signal
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText}\n${text.slice(0, 300)}`);
      }

      return res;
    }

    async function fetchAllPages(url, signal) {
      let page = 1;
      const out = [];
      while (true) {
        const u = new URL(url);
        u.searchParams.set("per_page", "100");
        u.searchParams.set("page", String(page));
        const res = await gitlabFetch(u.toString(), signal);
        const data = await res.json();
        out.push(...data);
        const nextPage = res.headers.get("x-next-page");
        if (!nextPage) break;
        page = Number(nextPage);
      }
      return out;
    }
    
    async function fetchIterationCadenceTitles(gitlabUrl, signal) {
      const query = `
        query IterationCadences($fullPath: ID!) {
          group(fullPath: $fullPath) {
            iterationCadences(includeAncestorGroups: true) {
              nodes {
                id
                title
              }
            }
          }
        }
      `;

      const res = await fetch(`${gitlabUrl}/api/graphql`, {
        method: "POST",
        headers: {
          ...headers(),
          "Content-Type": "application/json"
        },
        signal,
        body: JSON.stringify({
          operationName: "IterationCadences",
          query,
          variables: { fullPath: EPIC_GROUP_PATH }
        })
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GraphQL HTTP ${res.status}\n${text.slice(0, 300)}`);
      }

      const json = await res.json();
      const map = new Map();

      for (const cadence of json?.data?.group?.iterationCadences?.nodes || []) {
        map.set(cadence.id, cadence.title);
      }

      return map;
    }

    function extractNumericId(gid) {
      return String(gid || "").split("/").pop();
    }

    async function fetchIterationsWithCadenceInfo(gitlabUrl, signal) {
      const query = `
        query IterationsWithCadence($fullPath: ID!, $after: String) {
          group(fullPath: $fullPath) {
            iterations(first: 100, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                iid
                title
                startDate
                dueDate
                state
                webPath
                iterationCadence {
                  id
                  title
                }
              }
            }
          }
        }
      `;

      let after = null;
      const allIterations = [];

      while (true) {
        const res = await fetch(`${gitlabUrl}/api/graphql`, {
          method: "POST",
          headers: {
            ...headers(),
            "Content-Type": "application/json"
          },
          signal,
          body: JSON.stringify({
            operationName: "IterationsWithCadence",
            query,
            variables: {
              fullPath: EPIC_GROUP_PATH,
              after
            }
          })
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`GraphQL HTTP ${res.status}\n${text.slice(0, 300)}`);
        }

        const json = await res.json();

        const connection = json?.data?.group?.iterations;
        const nodes = connection?.nodes || [];

        allIterations.push(...nodes);

        if (!connection?.pageInfo?.hasNextPage) break;

        after = connection.pageInfo.endCursor;
      }

      return allIterations.map(iteration => ({
        id: extractNumericId(iteration.id),
        iid: iteration.iid,
        title: iteration.title,
        start_date: iteration.startDate,
        due_date: iteration.dueDate,
        state: iteration.state,
        web_url: iteration.webPath ? `${gitlabUrl}${iteration.webPath}` : null,
        cadence_id: iteration.iterationCadence?.id || null,
        cadence_title: iteration.iterationCadence?.title || null
      }));
    }

    function debounce(fn, delay = 250) {
      let timeoutId = null;

      return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
      };
    }

    function hideIterationResults() {
      const resultsEl = el("iterationResults");
      if (resultsEl) {
        resultsEl.classList.add("hidden");
        resultsEl.innerHTML = "";
      }
    }

    function formatIterationDateRange(iteration) {
      if (!iteration.start_date || !iteration.due_date) {
        return "No dates";
      }

      const start = new Date(`${iteration.start_date}T00:00:00`);
      const due = new Date(`${iteration.due_date}T00:00:00`);

      const startText = start.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric"
      });

      const dueText = due.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
      });

      return `${startText} – ${dueText}`;
    }

    function getIterationGroupTitle(iteration) {
      return (
        iteration.cadence_title ||
        iteration.cadence?.title ||
        iteration.iterationCadence?.title ||
        iteration.title ||
        "Iterations"
      );
    }

    function iterationMatchesQuery(iteration, query) {
      const q = query.trim().toLowerCase();

      const haystack = [
        iteration.id,
        iteration.iid,
        iteration.title,
        iteration.description,
        iteration.cadence_id,
        iteration.cadence?.title,
        iteration.cadence_title,
        iteration.iterationCadence?.title,
        iteration.start_date,
        iteration.due_date,
        formatIterationDateRange(iteration)
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(q);
    }

    function updateSelectedIterationsUI() {
      const selectedEl = el("selectedIterations");
      if (!selectedEl) return;

      const ids = parseIterationIds();

      if (!ids.length) {
        selectedEl.classList.add("hidden");
        selectedEl.innerHTML = "";
        return;
      }

      selectedEl.innerHTML = ids.map(id => {
        const label = selectedIterationLabels.get(String(id)) || `Iteration ${id}`;

        return `
          <span class="selected-chip" data-iteration-id="${escapeHtml(id)}">
            ${escapeHtml(label)}
            <button type="button" data-remove-iteration-id="${escapeHtml(id)}">×</button>
          </span>
        `;
      }).join("");

      selectedEl.classList.remove("hidden");

      selectedEl.querySelectorAll("[data-remove-iteration-id]").forEach(btn => {
        btn.addEventListener("click", () => {
          removeIterationId(btn.dataset.removeIterationId);
        });
      });
    }

    function addIterationId(iteration) {
      const currentIds = parseIterationIds();
      const nextId = String(iteration.id);

      if (!currentIds.includes(nextId)) {
        currentIds.push(nextId);
      }

      const groupTitle = getIterationGroupTitle(iteration);
      const dateRange = formatIterationDateRange(iteration);

      selectedIterationLabels.set(nextId, `${groupTitle}: ${dateRange}`);

      el("iterationIds").value = currentIds.join(",");
      updateSelectedIterationsUI();
    }

    function removeIterationId(iterationId) {
      const nextIds = parseIterationIds()
        .filter(id => String(id) !== String(iterationId));

      selectedIterationLabels.delete(String(iterationId));
      el("iterationIds").value = nextIds.join(",");

      updateSelectedIterationsUI();
    }

    function renderIterationResults(iterations, query) {
      const resultsEl = el("iterationResults");

      if (!resultsEl) return;

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const filtered = iterations
        .filter(iteration => {
          const dueDate = parseDateOnly(iteration.due_date);

          return (
            dueDate &&
            dueDate >= today &&
            iterationMatchesQuery(iteration, query)
          );
        })
        .sort((a, b) => {
          const aStart = parseDateOnly(a.start_date);
          const bStart = parseDateOnly(b.start_date);

          return aStart - bStart;
        })
        .slice(0, 3);

      if (!filtered.length) {
        resultsEl.innerHTML = `<div class="search-result-empty">No iterations found.</div>`;
        resultsEl.classList.remove("hidden");
        return;
      }

      const groups = new Map();

      for (const iteration of filtered) {
        const groupTitle = getIterationGroupTitle(iteration);

        if (!groups.has(groupTitle)) {
          groups.set(groupTitle, []);
        }

        groups.get(groupTitle).push(iteration);
      }

      const html = [];

      for (const [groupTitle, items] of groups.entries()) {
        html.push(`<div class="search-result-group">${escapeHtml(groupTitle)}</div>`);

        for (const iteration of items) {
          html.push(`
            <div
              class="search-result-item"
              data-iteration-id="${escapeHtml(iteration.id)}"
            >
              <div class="search-result-date">
                ${escapeHtml(formatIterationDateRange(iteration))}
              </div>
            </div>
          `);
        }
      }

      resultsEl.innerHTML = html.join("");
      resultsEl.classList.remove("hidden");

      resultsEl.querySelectorAll(".search-result-item").forEach(item => {
        item.addEventListener("click", () => {
          const selected = filtered.find(iteration =>
            String(iteration.id) === String(item.dataset.iterationId)
          );

          if (!selected) return;

          addIterationId(selected);

          el("iterationSearch").value = "";
          hideIterationResults();
        });
      });
    }

    async function searchIterations() {
      const mapMode = el("mapMode").value;

      if (mapMode !== "iteration") {
        hideIterationResults();
        return;
      }

      const query = el("iterationSearch").value.trim();

      if (query.length < 2) {
        hideIterationResults();
        return;
      }

      const gitlabUrl = el("gitlabUrl").value.trim().replace(/\/+$/, "");
      const token = el("token").value.trim();

      if (!gitlabUrl || !token) {
        el("iterationResults").innerHTML =
          `<div class="search-result-empty">Insert GitLab URL and token first.</div>`;
        el("iterationResults").classList.remove("hidden");
        return;
      }

      if (iterationSearchAbortController) {
        iterationSearchAbortController.abort();
      }

      iterationSearchAbortController = new AbortController();
      const signal = iterationSearchAbortController.signal;

      try {
        const iterations = await fetchIterationsWithCadenceInfo(gitlabUrl, signal);

        renderIterationResults(iterations, query);

      } catch (err) {
        if (err.name === "AbortError") return;

        console.error("Iteration search error", err);
        el("iterationResults").innerHTML =
          `<div class="search-result-empty">Search error.</div>`;
        el("iterationResults").classList.remove("hidden");
      }
    }

    function normalizeEdge(sourceId, targetId, type) {
      if (type === "blocks") return { from: sourceId, to: targetId, relation: "blocks" };
      if (type === "is_blocked_by") return { from: targetId, to: sourceId, relation: "blocks" };
      return { from: sourceId, to: targetId, relation: "relates_to" };
    }

    function iterationColorMap(iterationIds) {
      const map = new Map();
      iterationIds.forEach((id, idx) => map.set(id, palette[idx % palette.length]));
      return map;
    }

    function renderLegend() {
      const rows = [
        `<div class="legend-item"><span class="dot" style="background:${TEMPORAL_COLORS.current}"></span> ${TEMPORAL_LABELS.current}</div>`,
        `<div class="legend-item"><span class="dot" style="background:${TEMPORAL_COLORS.past}"></span> ${TEMPORAL_LABELS.past}</div>`,
        `<div class="legend-item"><span class="dot" style="background:${TEMPORAL_COLORS.overlap}"></span> ${TEMPORAL_LABELS.overlap}</div>`,
        `<div class="legend-item"><span class="dot" style="background:${TEMPORAL_COLORS.future}"></span> ${TEMPORAL_LABELS.future}</div>`,
        `<div class="legend-item"><span class="dot" style="background:${TEMPORAL_COLORS.unplanned_same_team}"></span> ${TEMPORAL_LABELS.unplanned_same_team}</div>`,
        `<div class="legend-item"><span class="dot" style="background:${TEMPORAL_COLORS.none_external}"></span> ${TEMPORAL_LABELS.none_external}</div>`,
        `<div class="legend-item"><span class="parent-box"></span> Parent / Epic</div>`,
        `<div class="legend-item"><span class="line dashed" style="border-color:#8b8fa3"></span> belongs to parent</div>`,
        `<div class="legend-item"><span class="line" style="border-color:#ffb86b"></span> blocks / blocked_by</div>`,
        `<div class="legend-item"><span class="line dashed" style="border-color:#8ea2d8"></span> relates_to</div>`,
        `<div class="legend-item"><span class="dot" style="background:transparent;border-color:#6dd6a1;border-width:3px"></span> closed issue border</div>`
      ];
      legendEl.innerHTML = rows.join("");
    }

    async function loadGraph() {

      currentAbortController = new AbortController();
      const signal = currentAbortController.signal;

      el("cancelBtn").disabled = false;

      const gitlabUrl = el("gitlabUrl").value.trim().replace(/\/+$/, "");
      const token = el("token").value.trim();
      const mapMode = el("mapMode").value;
      const iterationIds = parseIterationIds();
      const epicIds = parseEpicIds();
      const scope = el("scope").value;
      const edgeMode = el("edgeMode").value;
      const externalMode = el("externalMode").value;
      const loadBtn = el("loadBtn");
      const plannedOnly = el("plannedOnly").value;
      const parentMode = el("parentMode").value;

      if (!gitlabUrl || !token) {
        setStatus("Inserisci GitLab URL e token.", true);
        return;
      }

      if (mapMode === "iteration" && iterationIds.length === 0) {
        setStatus("Inserisci almeno un Iteration ID.", true);
        return;
      }

      if (mapMode === "epic" && epicIds.length === 0) {
        setStatus("Inserisci almeno un Epic ID.", true);
        return;
      }

      loadBtn.disabled = true;

      try {
        setStatus(mapMode === "epic" ? "Recupero issue delle epic..." : "Recupero issue delle iteration...");
        const colorMap = iterationColorMap(iterationIds);
        renderLegend();

        const issuesById = new Map();
        const selectedIterationWindows = [];
        const selectedTeamLabels = new Set();
        const parentDetailsCache = new Map();

        async function addSelectedIssue(issue, sourceScopeId) {
          const labels = issue.labels || [];
          if (
            plannedOnly === "planned_only" &&
            !hasPlannedLabel(labels)
          ) {
            return;
          }

          const id = issueKey(issue);
          const issueIteration = issue.iteration || null;
          const parentInfo = await enrichParentInfo(
            gitlabUrl,
            extractParentInfo(issue, gitlabUrl),
            parentDetailsCache
          );

          if (issueIteration?.start_date && issueIteration?.due_date) {
            selectedIterationWindows.push({
              id: String(issueIteration.id || sourceScopeId || issueIteration.id),
              start: issueIteration.start_date,
              due: issueIteration.due_date
            });
          }

          for (const teamLabel of getTeamLabels(labels)) {
            selectedTeamLabels.add(teamLabel);
          }

          if (!issuesById.has(id)) {
            issuesById.set(id, {
              id,
              projectId: issue.project_id,
              issueIid: issue.iid,
              title: issue.title,
              webUrl: issue.web_url,
              state: issue.state,
              labels,
              assignees: (issue.assignees || []).map(a => a.name),
              iterationId: issueIteration?.id ? String(issueIteration.id) : (mapMode === "iteration" ? String(sourceScopeId) : null),
              iterationStartDate: issueIteration?.start_date || null,
              iterationDueDate: issueIteration?.due_date || null,
              parentId: parentInfo?.id || null,
              parentIid: parentInfo?.iid || null,
              parentTitle: parentInfo?.title || null,
              parentUrl: parentInfo?.url || null,
              parentLabels: parentInfo?.labels || [],
              external: false,
              temporalStatus: "current"
            });
          }
        }

        if (mapMode === "epic") {
          const encodedGroup = encodeURIComponent(EPIC_GROUP_PATH);

          for (let i = 0; i < epicIds.length; i++) {
            const epicId = epicIds[i];
            setStatus(`Leggo issue epic ${epicId} (${i+1}/${epicIds.length})...`);

            const issuesUrl = `${gitlabUrl}/api/v4/groups/${encodedGroup}/epics/${encodeURIComponent(epicId)}/issues`;
            const issues = await fetchAllPages(issuesUrl, signal);

            for (const issue of issues) {
              await addSelectedIssue(issue, epicId);
            }
          }
        } else {
          for (let i = 0; i < iterationIds.length; i++) {
            const iterationId = iterationIds[i];
            setStatus(`Leggo issue della iteration ${iterationId} (${i+1}/${iterationIds.length})...`);
            const issuesUrl = `${gitlabUrl}/api/v4/issues?iteration_id=${encodeURIComponent(iterationId)}&scope=${encodeURIComponent(scope)}`;
            const issues = await fetchAllPages(issuesUrl);

            for (const issue of issues) {
              await addSelectedIssue(issue, iterationId);
            }
          }
        }

        const iterationNodeIds = new Set([...issuesById.keys()]);
        const edges = [];
        const dedupe = new Set();
        const issuesList = [...issuesById.values()];
        const externalDetailsCache = new Map();

        for (let i = 0; i < issuesList.length; i++) {
          const issueNode = issuesList[i];
          setStatus(`Leggo links issue ${i+1}/${issuesList.length}...`);
          const linksUrl = `${gitlabUrl}/api/v4/projects/${encodeURIComponent(issueNode.projectId)}/issues/${issueNode.issueIid}/links`;
          const issueLinks = await fetchAllPages(linksUrl, signal);

          for (const li of issueLinks) {
            const linkedId = li.references?.full || `${li.project_id}#${li.iid}`;
            const edge = normalizeEdge(issueNode.id, linkedId, li.link_type);

            // Applica il filtro relazione PRIMA di aggiungere issue/epic esterne.
            // Così, con "Block/Blocked by", non vengono inclusi nodi esterni
            // collegati solo tramite relates_to.
            if (edgeMode === "blocking_only" && edge.relation !== "blocks") continue;

            const linkedIsInSelection = iterationNodeIds.has(linkedId);

            if (!linkedIsInSelection && externalMode !== "show") continue;

            if (!linkedIsInSelection && externalMode === "show" && !issuesById.has(linkedId)) {
              let linkedIssue = li;
              const cacheKey = `${li.project_id}#${li.iid}`;

              if (externalDetailsCache.has(cacheKey)) {
                linkedIssue = externalDetailsCache.get(cacheKey);
              } else {
                try {
                  linkedIssue = await fetchIssueDetails(gitlabUrl, li.project_id, li.iid, signal);
                  externalDetailsCache.set(cacheKey, linkedIssue);
                } catch (err) {
                  console.warn("Impossibile recuperare dettagli issue esterna", linkedId, err);
                  externalDetailsCache.set(cacheKey, li);
                }
              }

              const linkedIteration = linkedIssue.iteration || null;
              const linkedLabels = linkedIssue.labels || li.labels || [];
              const parentInfo = await enrichParentInfo(
                gitlabUrl,
                extractParentInfo(linkedIssue, gitlabUrl),
                parentDetailsCache, signal
              );
              const externalNode = {
                id: linkedId,
                projectId: linkedIssue.project_id || li.project_id,
                issueIid: linkedIssue.iid || li.iid,
                title: linkedIssue.title || li.title || linkedId,
                webUrl: linkedIssue.web_url || li.web_url,
                state: linkedIssue.state || li.state || "opened",
                labels: linkedLabels,
                assignees: (linkedIssue.assignees || []).map(a => a.name),
                iterationId: linkedIteration?.id ? String(linkedIteration.id) : null,
                iterationStartDate: linkedIteration?.start_date || null,
                iterationDueDate: linkedIteration?.due_date || null,
                parentId: parentInfo?.id || null,
                parentIid: parentInfo?.iid || null,
                parentTitle: parentInfo?.title || null,
                parentUrl: parentInfo?.url || null,
                parentLabels: parentInfo?.labels || [],
                external: true
              };

              externalNode.temporalStatus = classifyTemporalStatus(
                externalNode,
                selectedIterationWindows,
                selectedTeamLabels
              );

              issuesById.set(linkedId, externalNode);
            }

            const key = `${edge.from}__${edge.to}__${edge.relation}`;
            if (dedupe.has(key)) continue;
            dedupe.add(key);

            edges.push({
              id: key,
              from: edge.from,
              to: edge.to,
              arrows: edge.relation === "blocks" ? "to" : "",
              dashes: edge.relation !== "blocks",
              color: edge.relation === "blocks" ? "#ffb86b" : "#8ea2d8",
              width: edge.relation === "blocks" ? 2.5 : 1.3,
              relation: edge.relation,
              title: edge.relation === "blocks" ? "blocks" : "relates_to",
              smooth: { type: "dynamic" }
            });
          }
        }

        const nodes = [...issuesById.values()].map(n => {
          const temporalStatus = n.temporalStatus || classifyTemporalStatus(n, selectedIterationWindows, selectedTeamLabels);
          const baseColor = mapMode === "epic" && n.external
            ? TEMPORAL_COLORS.none_external
            : getTemporalColor(temporalStatus);
          const borderColor = n.state === "closed" ? "#6dd6a1" : "#dfe7ff";
          const iterationText = n.iterationId
            ? `${n.iterationId}${n.iterationStartDate && n.iterationDueDate ? ` (${n.iterationStartDate} → ${n.iterationDueDate})` : ""}`
            : "none";
          const title = [
            `#${n.issueIid} ${n.title}`,
            `────────────────────`,
            mapMode === "epic"
              ? null
              : `🕒 ${TEMPORAL_LABELS[temporalStatus] || temporalStatus}`,
            `📅 ${iterationText}`,
            `👤 ${(n.assignees || []).join(", ") || "—"}`,
            `🏷️ ${(n.labels || []).join(", ") || "—"}`,
            `────────────────────`,
          ]
          .filter(Boolean)
          .join("\n");

          return {
            id: n.id,
            label: `#${n.issueIid}\n${truncate(n.title, 44)}`,
            shape: "dot",
            size: n.external ? 22 : 34,
            color: {
              background: baseColor,
              border: borderColor,
              highlight: { background: baseColor, border: "#ffffff" },
              hover: { background: baseColor, border: "#ffffff" }
            },
            font: { color: "#eef3ff", size: 14, face: "Inter" },
            borderWidth: 5,
            title,
            webUrl: n.webUrl,
            iterationId: n.iterationId,
            external: n.external,
            temporalStatus,
            parentId: n.parentId,
            parentIid: n.parentIid,
            parentTitle: n.parentTitle,
            parentUrl: n.parentUrl,
            parentLabels: n.parentLabels || []
          };
        });

        const parentGraph =
          buildParentNodesAndEdges(
            [...issuesById.values()],
            parentMode,
            mapMode === "epic" ? epicIds : []
          );

        const allNodes = [
          ...parentGraph.parentNodes,
          ...nodes
        ];

        const allEdges = [
          ...parentGraph.parentEdges,
          ...edges
        ];

        currentGraph = { nodes: allNodes, edges: allEdges };
        renderNetwork(allNodes, allEdges);
        if (nodesCountEl) nodesCountEl.textContent = String(allNodes.length);
        if (linksCountEl) linksCountEl.textContent = String(allEdges.length);
        setStatus(`Completato. ${allNodes.length} nodi, ${allEdges.length} link.`);
      } catch (err) {
          if (err.name === "AbortError") {
            setStatus("Map creation cancelled.");
            return;
          }
          console.error(err);
          setStatus(`Errore:\n${err.message}`, true);
        } finally {
          loadBtn.disabled = false;
          el("cancelBtn").disabled = true;
          currentAbortController = null;
        }
    }

    function truncate(str, maxLen) {
      if (!str) return "";
      return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str;
    }

    function renderNetwork(nodes, edges) {
      const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
      const options = {
        autoResize: true,
        interaction: { hover: true, tooltipDelay: 100, multiselect: true, zoomView: true, dragView: true },
        physics: {
          enabled: physicsEnabled,
          stabilization: { iterations: 300, fit: true },
          barnesHut: { gravitationalConstant: -6500, springLength: 150, springConstant: 0.035, damping: 0.18 }
        },
        nodes: { shadow: { enabled: true, color: "rgba(0,0,0,.28)", size: 12, x: 0, y: 5 } },
        edges: {
          shadow: false,
          smooth: {
            enabled: true,
            type: "dynamic",
            roundness: 0.35
          }
        }
      };

      network = new vis.Network(container, data, options);
      network.once("stabilizationIterationsDone", () => network.fit({ animation: true }));
      network.on("doubleClick", (params) => {
        if (!params.nodes.length) return;

        const node = data.nodes.get(params.nodes[0]);
        const url = node?.webUrl || node?.url || node?.web_url;

        if (url) {
          // Compatibile anche con Live Server / browser normali.
          // In alcuni preview di VS Code window.open viene intercettato e può fallire.
          const a = document.createElement("a");
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          document.body.appendChild(a);
          a.click();
          a.remove();
        } else {
          console.warn("Nessun URL trovato per questo nodo:", node);
          alert("Nessun URL GitLab trovato per questa issue.");
        }
      });
    }

    function downloadJSON() {
      const blob = new Blob([JSON.stringify(currentGraph, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "gitlab-iteration-map.json";
      a.click();
      URL.revokeObjectURL(url);
    }

    function downloadPNG() {
      const canvas = container.querySelector("canvas");
      if (!canvas) {
        setStatus("PNG non disponibile: carica prima una mappa.", true);
        return;
      }
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = "gitlab-iteration-map.png";
      a.click();
    }

    // ── AI Analysis ──────────────────────────────────────────────────────────
    async function analyzeWithAI() {
      if (!currentGraph.nodes.length) {
        setStatus("Genera prima una mappa.", true);
        return;
      }

      const aiPanel = el("aiPanel");
      const aiLoading = el("aiLoading");
      const aiResult = el("aiResult");
      const copyBtn = el("copyTeamsBtn");

      aiPanel.style.display = "block";
      aiLoading.style.display = "block";
      aiResult.style.display = "none";
      copyBtn.style.display = "none";

      // Cattura screenshot della mappa come base64
      let mapBase64 = null;
      try {
        const canvas = document.querySelector("#network canvas");
        if (canvas) mapBase64 = canvas.toDataURL("image/png").split(",")[1];
      } catch (e) { /* ignora */ }

      // Messaggio con JSON completo + immagine opzionale
      const userContent = mapBase64
        ? [
            { type: "image", source: { type: "base64", media_type: "image/png", data: mapBase64 } },
            { type: "text", text: "Genera il template HTML della sprint. JSON:\n" + JSON.stringify({ nodes: currentGraph.nodes, edges: currentGraph.edges }) }
          ]
        : [{ type: "text", text: "Genera il template HTML della sprint. JSON:\n" + JSON.stringify({ nodes: currentGraph.nodes, edges: currentGraph.edges }) }];

      try {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 8000,
            system: `Sei un assistente Scrum Master esperto. Ricevi il JSON di una dependency map GitLab e devi generare un template HTML descrittivo della sprint.

Il template HTML deve seguire ESATTAMENTE questo design system:
- Background body: #1A1A2E | Card: #20203A | Border: #2E2E50 | Font: 'Segoe UI', 13px
- Badge level: US bg #0F4C75 color #93C5FD | TS bg #1B4332 color #6EE7B7 | Analysis bg #3D1F00 color #FBC174 | Bug bg #7F1D1D color #FCA5A5 | Internal Bug bg #2E2E50 color #B0B0C8
- Badge status: Done bg #0F6E56 color #9FE1CB | Doing bg #1E3A5F color #93C5FD | To Do bg #252545 color #8080A8 | Ready bg #252545 color #B0B0C8
- Badge QA: Failed bg #7F1D1D color #FCA5A5 | Ready bg #0F6E56 color #9FE1CB | In Progress bg #1E3A5F color #93C5FD
- Tag Regression: bg #7C1D1D color #FCA5A5 | Tag Stretched: bg #633806 color #FBC174 | Tag EXT: bg #252545 color #606090
- Link colore #60A5FA | Assignee colore #8080A8
- Epic header: border-left 3px solid #b388ff, background #1E1A30, title color #e8e0ff
- Table row border-bottom: 0.5px solid #252545 | th: bg #1A1A2E color #606090 font-size 10px uppercase

Struttura del template:
1. h1 "Sprint — Team [nome se disponibile]" + div.meta con date e nome file
2. Alert bar (bg #2D1F00 border #92400E color #FBC174) se ci sono QA Failed o Regression
3. KPI row: 5 card flex — Totale, Done verde, In corso/Ready blu, To Do grigio, Blocchi attivi rosso
4. Issue raggruppate per epic tramite parentId. Ogni epic ha header viola e tabella con: # link, Titolo, Tipo badge, Status + QA badge, Assignee. Tag EXT/Regression/Stretched inline dopo #iid.
5. Sezione "Senza epic" per issue senza parentId
6. Sezione "Dipendenze": edges blocks → badge rosso "blocks" | edges relates_to → badge grigio "relates"
7. Footer color #3A3A5A

Regole estrazione JSON:
- level da labels: Level::UserStory→US, Level::TechStory→TS, Level::Analysis/POC→Analysis, Level::Bug→Bug, Level::InternalBug→Internal Bug
- status da labels: Status::Done, Status::Doing, Status::To Do, Status::Ready (escludi Status::QA::*)
- QA da labels: Status::QA::Failed, Status::QA::Ready, Status::QA::In Progress
- Regression = "Regression" nelle labels | Stretched = "Scheduling::Stretched" | EXT = external:true
- isParentNode:true = epic, non una issue
- edges relation "blocks" = blocchi | "relates_to" = collegati
- link cliccabile: usa webUrl del nodo

Restituisci SOLO il codice HTML completo, senza backtick, senza spiegazioni. Inizia con <!DOCTYPE html>.`,
            messages: [{ role: "user", content: userContent }]
          })
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

        const html = data.content?.[0]?.text || "";

        aiLoading.style.display = "none";

        // Apri il template come file scaricabile
        const blob = new Blob([html], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        const win = window.open(url, "_blank");
        if (!win) {
          // Scarica html se poupup bloccato
          const a = document.createElement("a");
          a.href = url;
          a.download = "sprint-template.html";
          a.click();
        }

        aiResult.innerHTML = "✅ Template generato!<br><small style='color:#8080A8'>Aperto in una nuova finestra.</small>";
        aiResult.style.display = "block";
        copyBtn.textContent = "⬇️ Scarica HTML";
        copyBtn.style.display = "block";
        copyBtn.onclick = () => {
          const blob = new Blob([html], { type: "text/html" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "sprint-template.html";
          a.click();
          URL.revokeObjectURL(url);
        };

      } catch (err) {
        aiLoading.style.display = "none";
        aiResult.textContent = "Errore: " + err.message;
        aiResult.style.display = "block";
        setStatus("Errore AI: " + err.message, true);
      }
    }

    el("loadBtn").addEventListener("click", loadGraph);
    el("fitBtn").addEventListener("click", () => network && network.fit({ animation: true }));
    el("physicsBtn").addEventListener("click", () => {
      physicsEnabled = !physicsEnabled;
      if (network) network.setOptions({ physics: { enabled: physicsEnabled } });
      setStatus(`Physics ${physicsEnabled ? "attivata" : "disattivata"}.`);
    });
    el("zoomInBtn").addEventListener("click", () => {
      if (!network) return;
      const scale = network.getScale();
      network.moveTo({ scale: scale * 1.2, animation: true });
    });
    el("zoomOutBtn").addEventListener("click", () => {
      if (!network) return;
      const scale = network.getScale();
      network.moveTo({ scale: scale / 1.2, animation: true });
    });
    el("pngBtn").addEventListener("click", downloadPNG);
    el("jsonBtn").addEventListener("click", downloadJSON);
    el("aiBtn").addEventListener("click", analyzeWithAI);


    el("gitlabUrl").value = "https://gitlab.com/";

    el("guideBtn").addEventListener("click", () => {
      el("guideModal").classList.remove("hidden");
      document.body.style.overflow = "hidden";
    });

    function closeGuide() {
      el("guideModal").classList.add("hidden");
      document.body.style.overflow = "";
    }

    el("closeGuideBtn").addEventListener("click", closeGuide);

    el("guideModal").addEventListener("click", (event) => {
      if (event.target.id === "guideModal") {
        closeGuide();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeGuide();
      }
    });

    const guideModal = el("guideModal");
    const guideContent = guideModal.querySelector(".modal-content");
    const guideHeader = guideModal.querySelector(".modal-header");

    let isDraggingGuide = false;
    let guideStartX = 0;
    let guideStartY = 0;
    let guideInitialX = 0;
    let guideInitialY = 0;

    guideHeader.addEventListener("mousedown", (event) => {
      if (event.target.id === "closeGuideBtn") return;

      isDraggingGuide = true;
      guideStartX = event.clientX;
      guideStartY = event.clientY;

      const rect = guideContent.getBoundingClientRect();
      guideInitialX = rect.left;
      guideInitialY = rect.top;

      guideContent.style.position = "fixed";
      guideContent.style.left = `${guideInitialX}px`;
      guideContent.style.top = `${guideInitialY}px`;
      guideContent.style.margin = "0";
    });

    document.addEventListener("mousemove", (event) => {
      if (!isDraggingGuide) return;

      const dx = event.clientX - guideStartX;
      const dy = event.clientY - guideStartY;

      guideContent.style.left = `${guideInitialX + dx}px`;
      guideContent.style.top = `${guideInitialY + dy}px`;
    });

    document.addEventListener("mouseup", () => {
      isDraggingGuide = false;
    });

    function syncMapInputs() {
      const mapMode = el("mapMode").value;

      const iterationInput = el("iterationIds");
      const iterationSearchInput = el("iterationSearch");
      const selectedIterationsEl = el("selectedIterations");
      const epicInput = el("epicIds");

      if (mapMode === "iteration") {
        iterationInput.disabled = false;
        if (iterationSearchInput) iterationSearchInput.disabled = false;
        if (selectedIterationsEl && parseIterationIds().length) {
          selectedIterationsEl.classList.remove("hidden");
        }

        epicInput.disabled = true;
      } else {
        iterationInput.disabled = true;

        if (iterationSearchInput) {
          iterationSearchInput.disabled = true;
          iterationSearchInput.value = "";
        }

        hideIterationResults();

        if (selectedIterationsEl) {
          selectedIterationsEl.classList.add("hidden");
        }

        epicInput.disabled = false;
      }
    }

    el("mapMode").addEventListener("change", syncMapInputs);

    // inizializzazione al caricamento
    syncMapInputs();

    el("cancelBtn").addEventListener("click", () => {
      if (currentAbortController) {
        currentAbortController.abort();
        setStatus("Map creation cancelled.");
      }

      el("cancelBtn").disabled = true;
    });

    const debouncedIterationSearch = debounce(searchIterations, 250);

    el("iterationSearch").addEventListener("input", debouncedIterationSearch);

    el("iterationSearch").addEventListener("focus", () => {
      if (el("iterationSearch").value.trim().length >= 2) {
        searchIterations();
      }
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".iteration-search-wrapper")) {
        hideIterationResults();
      }
    });

    el("iterationIds").addEventListener("input", updateSelectedIterationsUI);

    // ── URL param precompilation ──────────────────────────────────────────────
    (function applyUrlParams() {
      const p = new URLSearchParams(window.location.search);

      if (p.get("gitlab_url")) el("gitlabUrl").value = p.get("gitlab_url");
      if (p.get("token"))      el("token").value      = p.get("token");
      if (p.get("map_type"))   el("mapMode").value    = p.get("map_type");
      if (p.get("scope"))      el("scope").value       = p.get("scope");
      if (p.get("edge_mode"))  el("edgeMode").value    = p.get("edge_mode");
      if (p.get("external_mode")) el("externalMode").value = p.get("external_mode");

      if (p.get("iteration_id")) {
        el("iterationIds").value = p.get("iteration_id");
        syncMapInputs();
        updateSelectedIterationsUI();
      }

      const hasId = p.get("iteration_id") || p.get("epic_id");
      const hasToken = p.get("token");
      if (hasId && hasToken) {
        loadGraph();
      }
    })();