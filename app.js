// ─── IndexedDB helpers ────────────────────────────────────────────────────────
// Replaces localStorage so documents of any size can be stored.
const DB_NAME = 'chineseReaderDB';
const DB_VERSION = 4;   // Bump this whenever you add/remove object stores
let db = null;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (e) => {
            const d = e.target.result;
            // 'state'     – small key/value pairs (current doc name, page number)
            // 'documents' – full document content, keyed by name
            // 'wordlist'  – saved words, keyed by word text (deduplicates naturally)
            if (!d.objectStoreNames.contains('state')) {
                d.createObjectStore('state');
            }
            if (!d.objectStoreNames.contains('documents')) {
                d.createObjectStore('documents', { keyPath: 'name' });
            }
            if (!d.objectStoreNames.contains('wordlist')) {
                d.createObjectStore('wordlist', { keyPath: 'id' });
            }
        };

        request.onsuccess = (e) => { db = e.target.result; resolve(); };

        request.onerror = (e) => {
            // If opening failed, wipe the DB and start fresh rather than crashing
            console.warn('IndexedDB open failed, deleting and retrying…', e.target.error);
            const del = indexedDB.deleteDatabase(DB_NAME);
            del.onsuccess = () => initDB().then(resolve).catch(reject);
            del.onerror   = () => reject(e.target.error);
        };
    });
}

// Guard: if a transaction fails because a store is missing (e.g. stale DB from
// a failed previous upgrade), nuke the DB and reload so initDB runs cleanly.
function handleStoreNotFound(err) {
    if (err && err.name === 'NotFoundError') {
        console.warn('Object store missing — resetting database and reloading.');
        indexedDB.deleteDatabase(DB_NAME);
        location.reload();
    }
}

function idbGet(store, key) {
    return new Promise((resolve, reject) => {
        try {
            const req = db.transaction(store, 'readonly').objectStore(store).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror   = (e) => { handleStoreNotFound(e.target.error); reject(e.target.error); };
        } catch (err) { handleStoreNotFound(err); reject(err); }
    });
}

function idbPut(store, value, key) {
    return new Promise((resolve, reject) => {
        try {
            const tx  = db.transaction(store, 'readwrite');
            const os  = tx.objectStore(store);
            key !== undefined ? os.put(value, key) : os.put(value);
            tx.oncomplete = () => resolve();
            tx.onerror    = (e) => { handleStoreNotFound(e.target.error); reject(e.target.error); };
        } catch (err) { handleStoreNotFound(err); reject(err); }
    });
}

function idbDelete(store, key) {
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror    = (e) => { handleStoreNotFound(e.target.error); reject(e.target.error); };
        } catch (err) { handleStoreNotFound(err); reject(err); }
    });
}

function idbGetAll(store) {
    return new Promise((resolve, reject) => {
        try {
            const req = db.transaction(store, 'readonly').objectStore(store).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror   = (e) => { handleStoreNotFound(e.target.error); reject(e.target.error); };
        } catch (err) { handleStoreNotFound(err); reject(err); }
    });
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const fileInput        = document.getElementById('fileInput');
const fullscreenBtn    = document.getElementById('fullscreenBtn');
const savedDocsBtn     = document.getElementById('savedDocsBtn');
const wordListBtn      = document.getElementById('wordListBtn');
const reader           = document.getElementById('reader');
const tooltip          = document.getElementById('tooltip');
const savedDocsModal   = document.getElementById('savedDocsModal');
const savedDocsList    = document.getElementById('savedDocsList');
const wordListModal    = document.getElementById('wordListModal');
const wordListItems    = document.getElementById('wordListItems');
const closeWordListBtn = document.getElementById('closeWordList');
const prevPage         = document.getElementById('prevPage');
const nextPage         = document.getElementById('nextPage');
const pageInfo         = document.getElementById('pageInfo');

// ─── App state ────────────────────────────────────────────────────────────────
let currentDocContent = '';
let currentDocName    = '';
let pages             = [];
let currentPage       = 0;

// ─── Speech synthesis ─────────────────────────────────────────────────────────
if ('speechSynthesis' in window) {
    speechSynthesis.getVoices();
    if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
    }
}

// ─── Startup ──────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
    await initDB();

    const savedName = await idbGet('state', 'currentDocName');

    if (savedName) {
        const doc = await idbGet('documents', savedName);
        if (doc) {
            currentDocContent = doc.content;
            currentDocName    = savedName;
            await paginateContent(doc.content);
            const savedPageNum = await idbGet('state', `page_${savedName}`);
            currentPage = savedPageNum ? parseInt(savedPageNum) : 0;
            displayPage(currentPage);
			updateDocTitle();
        }
    }
});

// ─── Single-pass pagination ───────────────────────────────────────────────────
// The previous approach appended one node at a time and read scrollHeight after
// each append, causing one forced browser reflow per node — very slow for books.
//
// This version:
//   1. Inserts ALL nodes at once into an overflow:visible measure div.
//   2. Reads every node's position in a single forced reflow.
//   3. Computes page breaks in plain JS with no further DOM work.
//
// Total reflows: 1, regardless of document length.
//
// The one approximation: when content is split across pages, the first node on
// each new page loses any top-margin-collapse it had with its predecessor. For
// typical paragraph content this is negligible (a few pixels at most).
async function paginateContent(content) {
    reader.innerHTML = '<p style="color:#888;text-align:center;padding-top:40px">Paginating…</p>';

    // Wait one frame so reader dimensions are available
    await new Promise(r => requestAnimationFrame(r));

    const readerW = reader.clientWidth  || 600;
    const readerH = reader.clientHeight || 500;
    const pageH   = readerH - 40; // subtract top (20px) + bottom (20px) padding

    // overflow:visible lets all content render so we can measure it in one pass
    const measure = document.createElement('div');
    measure.style.cssText = [
        'position:fixed', 'visibility:hidden', 'pointer-events:none',
        'top:0', `left:-${readerW + 100}px`, `width:${readerW}px`,
        'font-size:20px', 'line-height:1.2', 'padding:20px',
        'overflow:visible', 'box-sizing:border-box', 'word-break:break-word',
    ].join(';');
    document.body.appendChild(measure);

    // Parse content; convert bare text nodes to <span>s so they are measurable
    const tmpDiv = document.createElement('div');
    tmpDiv.innerHTML = content;
    const elements = [];
    for (const n of tmpDiv.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) {
            if (!n.textContent.trim()) continue; // skip whitespace-only
            const s = document.createElement('span');
            s.textContent = n.textContent;
            elements.push(s);
        } else {
            elements.push(n.cloneNode(true));
        }
    }

    // Insert everything at once, then read positions — this is the one reflow
    const frag = document.createDocumentFragment();
    elements.forEach(el => frag.appendChild(el));
    measure.appendChild(frag);
    const rects = elements.map(el => el.getBoundingClientRect());
    document.body.removeChild(measure);

    // Compute page breaks using relative positions.
    // rects[i].bottom - rects[pageStart].top = how far node i's bottom sits
    // from the top of the first node on the current page. When this exceeds
    // pageH, we start a new page before node i.
    pages = [];
    let pageStart = 0;

    for (let i = 0; i < elements.length; i++) {
        const relBottom = rects[i].bottom - rects[pageStart].top;
        const isLast    = i === elements.length - 1;

        if (relBottom > pageH && i > pageStart) {
            // Node i overflows — save [pageStart, i-1] and reprocess i
            pages.push(elements.slice(pageStart, i).map(el => el.outerHTML).join(''));
            pageStart = i;
            i--; // will be incremented back to i by the loop
        } else if (relBottom > pageH || isLast) {
            // Single node taller than a page, or we have reached the end
            pages.push(elements.slice(pageStart, i + 1).map(el => el.outerHTML).join(''));
            pageStart = i + 1;
        }
    }

    if (pages.length === 0) pages.push(content);
}

// ─── Page display ─────────────────────────────────────────────────────────────
function displayPage(pageNum) {
    if (pages.length === 0) return;

    currentPage = Math.max(0, Math.min(pageNum, pages.length - 1));
    reader.innerHTML = pages[currentPage];
    attachWordListeners();

    pageInfo.textContent = `Page ${currentPage + 1} of ${pages.length}`;
    prevPage.disabled = currentPage === 0;
    nextPage.disabled = currentPage === pages.length - 1;

    idbPut('state', currentPage.toString(), `page_${currentDocName}`);
    reader.scrollTop = 0;
}

// ─── Page navigation ──────────────────────────────────────────────────────────
prevPage.addEventListener('click', () => {
    if (currentPage > 0) displayPage(currentPage - 1);
});

nextPage.addEventListener('click', () => {
    if (currentPage < pages.length - 1) displayPage(currentPage + 1);
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft'  || e.key === 'PageUp')   { if (currentPage > 0)                   displayPage(currentPage - 1); }
    if (e.key === 'ArrowRight' || e.key === 'PageDown')  { if (currentPage < pages.length - 1)    displayPage(currentPage + 1); }
});

// Touch swipe
let touchStartX = 0, touchEndX = 0, touchStartY = 0, touchEndY = 0;

reader.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
}, { passive: true });

reader.addEventListener('touchend', (e) => {
    if (e.target.classList.contains('zhword')) return;
    touchEndX = e.changedTouches[0].screenX;
    touchEndY = e.changedTouches[0].screenY;

    const diffX = touchStartX - touchEndX;
    const diffY = Math.abs(touchStartY - touchEndY);
    if (diffY < 50 && Math.abs(diffX) > 50) {
        if (diffX > 0) { if (currentPage < pages.length - 1) displayPage(currentPage + 1); }
        else           { if (currentPage > 0)                displayPage(currentPage - 1); }
    }
}, { passive: true });

// ─── File loading ─────────────────────────────────────────────────────────────
fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const fileReader = new FileReader();
    fileReader.onload = async (event) => {
        let content = event.target.result;

        if (content.includes('<body>')) {
            const bodyMatch = content.match(/<body[^>]*>([\s\S]*)<\/body>/i);
            if (bodyMatch) content = bodyMatch[1];
        }

        const docName = file.name.replace(/\.(txt|html)$/i, '');

        currentDocContent = content;
        currentDocName    = docName;
        currentPage       = 0;

        // Auto-save to library immediately
        await saveDocument(docName, content);
        await idbPut('state', docName, 'currentDocName');

        await paginateContent(content);
        displayPage(0);
		updateDocTitle();
    };

    fileReader.readAsText(file);
});

// ─── Fullscreen ───────────────────────────────────────────────────────────────
fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => alert(`Fullscreen error: ${err.message}`));
        fullscreenBtn.textContent = 'Exit Fullscreen';
    } else {
        document.exitFullscreen();
        fullscreenBtn.textContent = 'Fullscreen';
    }
});

document.addEventListener('fullscreenchange', () => {
    fullscreenBtn.textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen';
});


// ─── Document persistence (IndexedDB) ────────────────────────────────────────
async function saveDocument(name, content) {
    await idbPut('documents', { name, content, savedAt: new Date().toISOString() });
}

async function getSavedDocuments() {
    const docs = await idbGetAll('documents');
    // Return as object keyed by name to match existing usage
    return Object.fromEntries(docs.map(d => [d.name, d]));
}

async function loadDocument(name) {
    const savedDocs = await getSavedDocuments();
    const doc = savedDocs[name];
    if (!doc) return;

    currentDocContent = doc.content;
    currentDocName    = name;

    await paginateContent(doc.content);

    const savedPageNum = await idbGet('state', `page_${name}`);
    currentPage = savedPageNum ? parseInt(savedPageNum) : 0;
    displayPage(currentPage);
	updateDocTitle();

    await idbPut('state', name, 'currentDocName');

    hideSavedDocsModal();
}

async function deleteDocument(name) {
    if (!confirm(`Delete "${name}"?`)) return;
    await idbDelete('documents', name);

    if (currentDocName === name) {
        reader.innerHTML  = '';
        currentDocContent = '';
        currentDocName    = '';
        pages             = [];
        currentPage       = 0;
        await idbDelete('state', 'currentDocName');
        await idbDelete('state', 'currentPage');
        pageInfo.textContent = 'Page 1 of 1';
    }

    showSavedDocs();
}

// ─── Saved docs modal ─────────────────────────────────────────────────────────
savedDocsBtn.addEventListener('click', () => showSavedDocs());
closeModal.addEventListener('click', hideSavedDocsModal);
savedDocsModal.addEventListener('click', (e) => { if (e.target === savedDocsModal) hideSavedDocsModal(); });

async function showSavedDocs() {
    const savedDocs = await getSavedDocuments();
    savedDocsList.innerHTML = '';

    const docNames = Object.keys(savedDocs);
    if (docNames.length === 0) {
        savedDocsList.innerHTML = '<p class="no-docs">No saved documents</p>';
    } else {
        docNames.forEach(name => {
            const doc  = savedDocs[name];
            const item = document.createElement('div');
            item.className = 'doc-item';

            const info  = document.createElement('div');  info.className = 'doc-info';
            const title = document.createElement('div');  title.className = 'doc-title'; title.textContent = name;
            const date  = document.createElement('div');  date.className  = 'doc-date';  date.textContent  = new Date(doc.savedAt).toLocaleDateString();
            info.append(title, date);

            const btns   = document.createElement('div'); btns.className = 'doc-buttons';
            const loadBtn = document.createElement('button');
            loadBtn.className = 'btn btn-small';
            loadBtn.textContent = 'Load';
            loadBtn.onclick = () => loadDocument(name);

            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-secondary btn-small';
            delBtn.textContent = 'Delete';
            delBtn.onclick = () => deleteDocument(name);

            btns.append(loadBtn, delBtn);
            item.append(info, btns);
            savedDocsList.appendChild(item);
        });
    }

    savedDocsModal.classList.remove('hidden');
}

function hideSavedDocsModal() {
    savedDocsModal.classList.add('hidden');
}

// ─── Word tooltip ─────────────────────────────────────────────────────────────
function attachWordListeners() {
    wrapEnglishWords(reader);

    reader.querySelectorAll('.zhword').forEach(word => {
        word.addEventListener('click', (e) => { e.stopPropagation(); showTooltip(word, e); });
    });

    reader.querySelectorAll('.enword').forEach(word => {
        word.addEventListener('click', (e) => { e.stopPropagation(); showEnglishTooltip(word, e); });
    });
}

// Walk text nodes in the reader and wrap English words in .enword spans.
// Skips text inside .zhword, pin, and button elements.
function wrapEnglishWords(container) {
    const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                if (node.parentElement.closest('.zhword, pin, button')) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    for (const textNode of textNodes) {
        if (!/[a-zA-Z]/.test(textNode.textContent)) continue;
        const frag  = document.createDocumentFragment();
        const parts = textNode.textContent.split(/(\b[a-zA-Z][a-zA-Z'-]*\b)/);
        for (const part of parts) {
            if (/^[a-zA-Z][a-zA-Z'-]*$/.test(part)) {
                const span = document.createElement('span');
                span.className   = 'enword';
                span.textContent = part;
                frag.appendChild(span);
            } else {
                frag.appendChild(document.createTextNode(part));
            }
        }
        textNode.parentNode.replaceChild(frag, textNode);
    }
}

// Brief highlight on the word that was just saved
function flashWord(el) {
    el.classList.add('word-added');
    setTimeout(() => el.classList.remove('word-added'), 800);
}

function showTooltip(wordElement, event) {
    const chinese    = wordElement.textContent;
    const title      = wordElement.getAttribute('title') || '';
    const pinElement = wordElement.nextElementSibling;
    const rawPinyin  = pinElement && pinElement.tagName.toLowerCase() === 'pin'
        ? pinElement.textContent.replace(/[()]/g, '') : '';

    let displayPinyin = rawPinyin;
    let english       = '';

    if (title.includes(' / ')) {
        const parts   = title.split(' / ');
        displayPinyin = parts[0] || rawPinyin;
        english       = parts[1] || '';
    } else if (title) {
        if (title.match(/[a-zA-Z]/)) english = title;
        else                         displayPinyin = title;
    }

    tooltip.querySelector('.tooltip-chinese').textContent = chinese;
    tooltip.querySelector('.tooltip-pinyin').textContent  = displayPinyin;
    tooltip.querySelector('.tooltip-english').textContent = english;
    tooltip.querySelector('.tooltip-speak').style.display = '';
    tooltip.classList.remove('hidden');

    const rect          = wordElement.getBoundingClientRect();
    const tooltipRect   = tooltip.getBoundingClientRect();
    const vw            = window.innerWidth;
    const vh            = window.innerHeight;

    let left = rect.left;
    let top  = rect.bottom + 10;

    if (left + tooltipRect.width > vw) left = vw - tooltipRect.width - 10;
    if (left < 10)                     left = 10;
    if (top  + tooltipRect.height > vh) {
        top = rect.top - tooltipRect.height - 10;
        if (top < 10) top = 10;
    }

    tooltip.style.left = `${left}px`;
    tooltip.style.top  = `${top}px`;
    tooltip.querySelector('.tooltip-speak').onclick    = () => speakChinese(chinese);
    tooltip.querySelector('.tooltip-save').onclick     = () => {
        addToWordList({ id: chinese, type: 'chinese', chinese, pinyin: displayPinyin, english });
        flashWord(wordElement);
        tooltip.classList.add('hidden');
    };
}

function showEnglishTooltip(wordElement, event) {
    const word = wordElement.textContent;

    tooltip.querySelector('.tooltip-chinese').textContent = word;
    tooltip.querySelector('.tooltip-pinyin').textContent  = '';
    tooltip.querySelector('.tooltip-english').textContent = '';
    tooltip.querySelector('.tooltip-speak').style.display = 'none';
    tooltip.classList.remove('hidden');

    const rect        = wordElement.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const vw          = window.innerWidth;
    const vh          = window.innerHeight;

    let left = rect.left;
    let top  = rect.bottom + 10;

    if (left + tooltipRect.width > vw)   left = vw - tooltipRect.width - 10;
    if (left < 10)                        left = 10;
    if (top  + tooltipRect.height > vh) {
        top = rect.top - tooltipRect.height - 10;
        if (top < 10) top = 10;
    }

    tooltip.style.left = `${left}px`;
    tooltip.style.top  = `${top}px`;

    tooltip.querySelector('.tooltip-speak').onclick = () => {
        if ('speechSynthesis' in window) {
            const utt  = new SpeechSynthesisUtterance(word);
            utt.lang   = 'en-US';
            speechSynthesis.speak(utt);
        }
    };
    tooltip.querySelector('.tooltip-save').onclick = () => {
        addToWordList({ id: word.toLowerCase(), type: 'english', word });
        flashWord(wordElement);
        tooltip.classList.add('hidden');
    };
}

document.addEventListener('click', (e) => {
    if (!tooltip.contains(e.target) && !e.target.classList.contains('zhword') && !e.target.classList.contains('enword')) {
        tooltip.classList.add('hidden');
    }
});

// ─── Word list ────────────────────────────────────────────────────────────────
async function addToWordList(entry) {
    await idbPut('wordlist', { ...entry, addedAt: new Date().toISOString() });
}

async function removeFromWordList(id) {
    await idbDelete('wordlist', id);
    showWordList();
}

wordListBtn.addEventListener('click', showWordList);
closeWordListBtn.addEventListener('click', () => wordListModal.classList.add('hidden'));
wordListModal.addEventListener('click', (e) => { if (e.target === wordListModal) wordListModal.classList.add('hidden'); });

async function showWordList() {
    const entries = await idbGetAll('wordlist');
    wordListItems.innerHTML = '';

    if (entries.length === 0) {
        wordListItems.innerHTML = '<p class="no-docs">No words saved yet. Click any word while reading to add it.</p>';
    } else {
        // Sort newest first
        entries.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
        entries.forEach(entry => {
            const row = document.createElement('div');
            row.className = 'word-item';

            const info = document.createElement('div');
            info.className = 'word-info';

            if (entry.type === 'chinese') {
                info.innerHTML = `
                    <span class="word-chinese">${entry.chinese}</span>
                    <span class="word-pinyin">${entry.pinyin}</span>
                    <span class="word-english">${entry.english}</span>`;
            } else {
                info.innerHTML = `<span class="word-english-only">${entry.word}</span>`;
            }

            const delBtn = document.createElement('button');
            delBtn.className   = 'btn btn-secondary btn-small';
            delBtn.textContent = 'Remove';
            delBtn.onclick     = () => removeFromWordList(entry.id);

            row.append(info, delBtn);
            wordListItems.appendChild(row);
        });
    }

    wordListModal.classList.remove('hidden');
}

// ─── Text-to-speech ───────────────────────────────────────────────────────────
function speakChinese(text) {
    if ('speechSynthesis' in window) {
        const utt  = new SpeechSynthesisUtterance(text);
        utt.lang   = 'zh-CN';
        speechSynthesis.speak(utt);
    } else {
        alert('Text-to-speech not supported on this device');
    }
}


const docTitle = document.getElementById('docTitle');

function updateDocTitle() {
    docTitle.textContent = currentDocName || '';
}