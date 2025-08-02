const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const path = require("path");
const axios = require("axios");

const scopes = ["https://www.googleapis.com/auth/spreadsheets"];

const app = express();
const PORT = process.env.PORT || 3001;
app.use(bodyParser.json());

// 시트 데이터 읽기
async function getRowsFromSheet(sheets, spreadsheetId, sheetName) {
  const range = `${sheetName}!G7:I`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  return res.data.values || [];
}

// 키워드별 타겟 MID 순위 조회 및 조기 종료 기능 추가
async function fetchItemsForKeyword(keyword, targets) {
  const basic_url = "https://openapi.naver.com/v1/search/shop?query=";
  let clientId, clientSecret;
  if (process.env.NAVER_KEY_JSON) {
    const keyObject = JSON.parse(process.env.NAVER_KEY_JSON);
    clientId = keyObject.clientId;
    clientSecret = keyObject.clientSecret;
  } else {
    const keyObject = require(path.join(__dirname, "package-naver-key.json"));
    clientId = keyObject.clientId;
    clientSecret = keyObject.clientSecret;
  }
  const headers = {
    "X-Naver-Client-Id": clientId,
    "X-Naver-Client-Secret": clientSecret,
  };
  const displayNum = 100;
  const targetSet = new Set(targets.map(String));
  const midToRank = {};
  let foundCount = 0;

  // 최대 500개까지 조회
  for (let i = 0; i < 5; i++) {
    const startNum = displayNum * i + 1;
    const url = `${basic_url}${encodeURIComponent(
      keyword
    )}&display=${displayNum}&start=${startNum}`;
    try {
      const response = await axios.get(url, { headers });
      const json = response.data;
      if (json.items && json.items.length > 0) {
        json.items.forEach((item, idx) => {
          const id = String(item.productId);
          if (targetSet.has(id) && midToRank[id] === undefined) {
            midToRank[id] = startNum + idx;
            foundCount++;
          }
        });
        if (foundCount >= targetSet.size) {
          // 모든 타겟 MID 발견 시 조기 종료
          return midToRank;
        }
      } else {
        break; // 아이템이 없으면 중단
      }
    } catch (e) {
      console.log("API 호출 오류: ", e.message);
      break;
    }
    // await sleep(300);
  }
  return midToRank;
}

// 결과 시트에 입력(J열에 열 추가)
async function sendDataToSheet(
  sheets,
  ranks,
  sheetId,
  sheetName,
  spreadsheetId
) {
  const colorCellRow = 5;
  const colorCellCol = 9; // J열(0부터 시작)
  const writeRange = `${sheetName}!J6:J${6 + ranks.length}`;
  const date = new Date();
  const rankRowName = date
    .toLocaleString("sv-SE", { hour12: false, timeZone: "Asia/Seoul" })
    .slice(2, 16)
    .replace("T", " ");
  const values = [[rankRowName], ...ranks];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId: sheetId,
              dimension: "COLUMNS",
              startIndex: colorCellCol,
              endIndex: colorCellCol + 1,
            },
            inheritFromBefore: false,
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: sheetId,
              startRowIndex: colorCellRow,
              endRowIndex: colorCellRow + 1,
              startColumnIndex: colorCellCol,
              endColumnIndex: colorCellCol + 1,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: {
                  red: 0.6118,
                  green: 0.1529,
                  blue: 0.6902,
                },
                horizontalAlignment: "center",
              },
            },
            fields:
              "userEnteredFormat.backgroundColor,userEnteredFormat.horizontalAlignment",
          },
        },
      ],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: writeRange,
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// POST 요청 받는 엔드포인트
app.post("/naver_trigger", async (req, res) => {
  const { spreadsheetId, sheetName, sheetId } = req.body;
  if (!spreadsheetId || !sheetName || !sheetId) {
    return res.status(400).json({ error: "필수값 누락" });
  }

  try {
    let auth;
    if (process.env.GOOGLE_KEY_JSON) {
      const keyObject = JSON.parse(process.env.GOOGLE_KEY_JSON);
      auth = new google.auth.GoogleAuth({ credentials: keyObject, scopes });
    } else {
      auth = new google.auth.GoogleAuth({
        keyFile: path.join(__dirname, "package-google-key.json"),
        scopes,
      });
    }
    const sheets = google.sheets({ version: "v4", auth });

    // 시트에서 데이터 읽기
    const rows = await getRowsFromSheet(sheets, spreadsheetId, sheetName);
    console.log("순위 조회 시작!");

    // 같은 키워드끼리 그룹핑
    const groups = {};
    rows.forEach((row, idx) => {
      const [keyword, productMid, compareMid] = row;
      if (!keyword || !productMid) return;
      if (!groups[keyword]) groups[keyword] = [];
      groups[keyword].push({ productMid, compareMid, idx });
    });

    // 결과 배열 초기화
    let ranks = Array(rows.length).fill(null);

    // 그룹별로 한 번만 크롤링 후 각 항목별 순위 조회
    for (const [keyword, entries] of Object.entries(groups)) {
      // 타겟 MID 목록 생성
      const targetMids = entries.reduce((acc, { productMid, compareMid }) => {
        if (compareMid) acc.push(compareMid);
        acc.push(productMid);
        return acc;
      }, []);
      const itemsMap = await fetchItemsForKeyword(keyword, [
        ...new Set(targetMids),
      ]);

      entries.forEach(({ productMid, compareMid, idx }) => {
        let rankValue;
        if (compareMid && itemsMap[compareMid] !== undefined) {
          rankValue = String(itemsMap[compareMid]);
        } else if (itemsMap[productMid] !== undefined) {
          rankValue = String(itemsMap[productMid]);
        } else {
          rankValue = "확인 불가";
        }
        ranks[idx] = [rankValue];
        // console.log(`keyword: ${keyword}, idx: ${idx + 1}, rank: ${rankValue}`);
      });
    }

    // 빈 값은 공백 처리
    ranks = ranks.map((r) => r || [""]);

    // 시트에 순위 반영
    await sendDataToSheet(sheets, ranks, sheetId, sheetName, spreadsheetId);

    console.log("순위 업데이트 완료!");
    return res.json({ status: "success" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`서버가 실행중입니다. 포트: ${PORT}`);
});
