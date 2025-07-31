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

// 네이버 크롤링
async function naverCrawling(keyword, mid) {
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
  let rank = 0;
  let findYn = false;

  for (let i = 0; i < 10; i++) {
    const startNum = displayNum * i + 1;
    const url = `${basic_url}${encodeURIComponent(
      keyword
    )}&display=${displayNum}&start=${startNum}`;

    try {
      const response = await axios.get(url, { headers: headers });
      const json = response.data;

      if (json.items && json.items.length > 0) {
        for (let j = 0; j < json.items.length; j++) {
          const item = json.items[j];
          rank = startNum + j;
          if (item && String(item.productId) === String(mid)) {
            findYn = true;
            break;
          }
        }
      }
      if (findYn) break;
    } catch (e) {
      console.log("API 호출 오류: ", e.message);
      break;
    }
  }

  if (findYn) {
    return String(rank);
  } else {
    return "확인 불가";
  }
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

  // 열 삽입 & 색상 등
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

  // 순위 데이터 입력
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

  let auth;
  try {
    // 구글 인증
    if (process.env.GOOGLE_KEY_JSON) {
      // 환경변수에 JSON이 있으면 credentials 옵션
      const keyObject = JSON.parse(process.env.GOOGLE_KEY_JSON);
      auth = new google.auth.GoogleAuth({
        credentials: keyObject,
        scopes: scopes,
      });
    } else {
      // 파일로 쓸 때만 keyFile 옵션
      auth = new google.auth.GoogleAuth({
        keyFile: path.join(__dirname, "package-google-key.json"),
        scopes: scopes,
      });
    }
    const sheets = google.sheets({ version: "v4", auth });

    // 시트에서 데이터 읽기
    const rows = await getRowsFromSheet(sheets, spreadsheetId, sheetName);

    // 키워드/MID 추출
    let ranks = [];
    for (const row of rows) {
      const keyword = row[0];
      const productMid = row[1];
      const compareMid = row[2];
      if (!keyword || !productMid) {
        ranks.push([""]);
        continue;
      }
      const useMid = compareMid && compareMid !== "" ? compareMid : productMid;
      const rank = await naverCrawling(keyword, useMid);
      ranks.push([rank]);
      console.log(`keyword: ${keyword}, mid: ${useMid}, rank: ${rank}`);
      await sleep(500);
    }

    // 순위값 시트에 반영
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
