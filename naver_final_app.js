const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const path = require("path");
const axios = require("axios");
const pLimit = require("p-limit");

const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
const app = express();
const PORT = process.env.PORT || 3001;
app.use(bodyParser.json());

const naverKeys = (() => {
  if (process.env.NAVER_KEYS_JSON) {
    return JSON.parse(process.env.NAVER_KEYS_JSON);
  } else {
    return require(path.join(__dirname, "package-naver-key.json"));
  }
})();

let keyIndex = 0;
// 네이버 인증키 순환
function getNextNaverHeaders() {
  const { clientId, clientSecret } = naverKeys[keyIndex];
  keyIndex = (keyIndex + 1) % naverKeys.length;
  return {
    "X-Naver-Client-Id": clientId,
    "X-Naver-Client-Secret": clientSecret
  };
}

// 한 번에 최대 7개 그룹 동시 처리
const groupLimit = pLimit(7);

// 시트 읽기
async function getRowsFromSheet(sheets, spreadsheetId, sheetName) {
  const range = `${sheetName}!G7:I`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

// 재시도용 sleep
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// axios.get 래퍼: 429 시 재시도 + 키 순환
async function axiosGetWithRetry(url, retries = 5, backoff = 300) {
  try {
    const headers = getNextNaverHeaders();
    return await axios.get(url, { headers });
  } catch (err) {
    if (
      err.response &&
      err.response.status === 429 &&
      retries > 0
    ) {
      const ra = err.response.headers["retry-after"];
      const wait = ra ? parseFloat(ra) * 1000 : backoff;
      // console.warn(`429 received, retrying after ${wait}ms (${retries} retries left)`);
      await sleep(wait);
      return axiosGetWithRetry(url, retries - 1, backoff * 2);
    }
    throw err;
  }
}

// 키워드 검색 시 3페이지 병렬 요청 & 429 재시도
async function fetchItemsForKeyword(keyword, targets) {
  const displayNum = 100;
  const targetSet = new Set(targets.map(String));
  const midToRank = {};

  const pageLimit = pLimit(3);
  // 상품 500개까지 검색
  const pageTasks = Array.from({ length: 5 }, (_, i) => {
    const start = i * displayNum + 1;
    const url = `https://openapi.naver.com/v1/search/shop?query=${encodeURIComponent(keyword)}&display=${displayNum}&start=${start}`;
    return pageLimit(async () => {
      const response = await axiosGetWithRetry(url);
      return { data: response.data, start };
    }).catch(() => null);
  });

  const responses = await Promise.all(pageTasks);
  for (const resp of responses) {
    if (!resp || !resp.data.items) continue;
    resp.data.items.forEach((item, idx) => {
      const id = String(item.productId);
      if (targetSet.has(id) && midToRank[id] === undefined) {
        midToRank[id] = resp.start + idx;
      }
    });
    if (Object.keys(midToRank).length >= targetSet.size) break;
  }
  return midToRank;
}

// 구글 시트에 열 추가
async function addColumnInSheet(sheets, sheetId, spreadsheetId) {
   await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 9, endIndex: 10 },
            inheritFromBefore: false,
          },
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 5,
              endRowIndex: 6,
              startColumnIndex: 9,
              endColumnIndex: 10,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.6118, green: 0.1529, blue: 0.6902 },
                horizontalAlignment: "CENTER",
              },
            },
            fields: "userEnteredFormat(backgroundColor, horizontalAlignment)",
          },
        },
      ],
    },
  });
}

// 구글 시트에 순위 업데이트
async function sendDataToSheet(sheets, ranks, sheetName, spreadsheetId) {
  const date = new Date()
    .toLocaleString("sv-SE", { hour12: false, timeZone: "Asia/Seoul" })
    .slice(2, 16)
    .replace("T", " ");
  const values = [[date], ...ranks];
  const writeRange = `${sheetName}!J6:J${6 + ranks.length}`;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: [{ range: writeRange, values }],
    },
  });
}

app.post("/naver_trigger", async (req, res) => {
  const { spreadsheetId, sheetName, sheetId } = req.body;
  if (!spreadsheetId || !sheetName || !sheetId) {
    return res.status(400).json({ error: "필수값 누락" });
  }

  console.log("순위 조회 시작!");

  try {
    const auth = process.env.GOOGLE_KEY_JSON
      ? new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_KEY_JSON), scopes })
      : new google.auth.GoogleAuth({ keyFile: path.join(__dirname, "package-google-key.json"), scopes });
    const sheets = google.sheets({ version: "v4", auth });

    await addColumnInSheet(sheets, sheetId, spreadsheetId);

    const rows = await getRowsFromSheet(sheets, spreadsheetId, sheetName);

    // 키워드별 그룹핑
    const groups = {};
    rows.forEach((row, idx) => {
      const [kw, prod, cmp] = row;
      if (!kw || !prod) return;
      groups[kw] = groups[kw] || [];
      groups[kw].push({ prod, cmp, idx });
    });

    // 그룹별 동시 병렬 처리
    const ranks = Array(rows.length).fill([""]);
    await Promise.all(
      Object.entries(groups).map(([kw, entries]) =>
        groupLimit(async () => {
          const mids = [...new Set(entries.flatMap(e => e.cmp ? [e.cmp, e.prod] : [e.prod]))];
          const map = await fetchItemsForKeyword(kw, mids);

          entries.forEach(({ prod, cmp, idx }) => {
            let r =
              cmp && map[cmp] !== undefined
                ? map[cmp]
                : map[prod] !== undefined
                ? map[prod]
                : "확인 불가";
            ranks[idx] = [String(r)];
          });
        })
      )
    );

    await sendDataToSheet(sheets, ranks, sheetName, spreadsheetId);
    console.log("순위 업데이트 완료!");
    return res.json({ status: "success" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`서버 실행중 포트: ${PORT}`);
});
