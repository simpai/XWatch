import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..");
const outputDir = path.resolve(projectRoot, "store", "screenshots");

const WIDTH = 1280;
const HEIGHT = 800;

const shots = [
  {
    file: "01-overview-ko.png",
    badge: "XMate",
    title: "X에서 기억해야 할 사람, 바로 메모",
    subtitle: "프로필 메모 + 타임라인 인라인 표시 + 다기기 동기화",
    chips: ["프로필 메모", "타임라인 표시", "userId 기반 저장", "sync 동기화"],
    panelTitle: "한눈에 보는 핵심 기능",
    panelBody: `
      <div class="grid two">
        <div class="card">
          <h3>프로필 메모</h3>
          <p>프로필 화면에서 바로 작성하고 저장</p>
          <div class="inline-box">XMate 메모 | 나중에 DM 보내기 | 저장</div>
        </div>
        <div class="card">
          <h3>타임라인 표시</h3>
          <p>게시물 사용자 이름 옆에 메모 인라인 노출</p>
          <div class="mock-user">Story <span class="note">나중에 협업 제안</span></div>
        </div>
      </div>
    `
  },
  {
    file: "02-profile-memo-ko.png",
    badge: "Profile",
    title: "프로필에서 바로 메모 저장",
    subtitle: "UserDescription 아래에 얇은 입력줄로 자연스럽게 배치",
    chips: ["즉시 저장", "재방문시 자동 로드", "회색톤 UI"],
    panelTitle: "프로필 메모 UI",
    panelBody: `
      <div class="profile-shell">
        <div class="avatar"></div>
        <div class="profile-meta">
          <div class="name">mikiglico</div>
          <div class="handle">@mikiglico</div>
          <div class="inline-box">XMate 메모 | 지난번 콜라보 긍정적 | 저장</div>
        </div>
      </div>
    `
  },
  {
    file: "03-timeline-note-ko.png",
    badge: "Timeline",
    title: "타임라인에서 메모를 즉시 확인",
    subtitle: "게시물 컨텍스트에서 누구인지 바로 떠오르게",
    chips: ["줄바꿈 없음", "이름 옆 인라인", "회색 배지 스타일"],
    panelTitle: "인라인 메모 표시",
    panelBody: `
      <div class="timeline">
        <div class="tweet">
          <div class="row"><span class="name">Story</span><span class="verify">✔</span><span class="note">협업 제안 보냄</span></div>
          <p>이번 주에 공개할 프로젝트를 준비 중입니다.</p>
        </div>
        <div class="tweet">
          <div class="row"><span class="name">Drew Vanilla</span><span class="note">답장 느림, 일주일 뒤 재확인</span></div>
          <p>새로운 스레드를 정리해서 공유합니다.</p>
        </div>
      </div>
    `
  },
  {
    file: "04-schedule-shortcuts-ko.png",
    badge: "Schedule",
    title: "예약 전송 시간 단축 버튼",
    subtitle: "복잡한 6개 컨트롤 대신 버튼으로 빠르게 조정",
    chips: ["5/10/30/60분", "+1h / -1h", "+1d / -1d"],
    panelTitle: "예약하기 모달 보조 패널",
    panelBody: `
      <div class="schedule">
        <div class="schedule-header">2026년 2월 24일 (화) 오후 11:47에 전송 예정</div>
        <div class="btn-row">
          <span class="btn">5분뒤</span><span class="btn">10분뒤</span><span class="btn">30분뒤</span><span class="btn">1시간뒤</span>
        </div>
        <div class="btn-row">
          <span class="btn">+1시간</span><span class="btn">-1시간</span><span class="btn">+1일</span><span class="btn">-1일</span>
        </div>
      </div>
    `
  },
  {
    file: "05-options-viewer-ko.png",
    badge: "Options",
    title: "저장 메모를 설정에서 통합 관리",
    subtitle: "조회/검색/삭제 + chrome.storage.sync 남은 공간 확인",
    chips: ["메모 뷰어", "항목 삭제", "용량 확인"],
    panelTitle: "설정 페이지",
    panelBody: `
      <div class="options">
        <div class="quota">
          <div><b>총 할당량</b> 102,400 bytes</div>
          <div><b>사용량</b> 12,410 bytes</div>
          <div><b>남은 공간</b> 89,990 bytes</div>
        </div>
        <div class="table">
          <div class="tr head"><span>User ID</span><span>Handle</span><span>Comment</span><span>Action</span></div>
          <div class="tr"><span>1789...</span><span>@mikiglico</span><span>협업 제안 보냄</span><span>삭제</span></div>
          <div class="tr"><span>5521...</span><span>@drew</span><span>나중에 재확인</span><span>삭제</span></div>
        </div>
      </div>
    `
  }
];

function renderHtml(shot, logoDataUrl) {
  const chips = shot.chips.map((chip) => `<span class="chip">${chip}</span>`).join("");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; font-family: "Segoe UI", "Noto Sans KR", sans-serif; color: #e6edf3; }
    body {
      background: radial-gradient(1200px 600px at -10% -10%, rgba(124,58,237,.25), transparent 50%),
                  radial-gradient(1000px 500px at 110% -20%, rgba(56,189,248,.2), transparent 55%),
                  linear-gradient(150deg, #0b1021 0%, #111827 45%, #172554 100%);
      padding: 36px;
    }
    .wrap { height: 100%; border-radius: 24px; background: rgba(10,14,28,.62); border: 1px solid rgba(255,255,255,.15); backdrop-filter: blur(6px); padding: 30px; display: flex; flex-direction: column; gap: 18px; }
    .top { display: flex; justify-content: space-between; align-items: center; }
    .brand { display: flex; align-items: center; gap: 14px; }
    .brand img { width: 56px; height: 56px; border-radius: 14px; }
    .brand h1 { margin: 0; font-size: 36px; letter-spacing: .2px; }
    .badge { font-size: 14px; padding: 8px 12px; border-radius: 999px; background: rgba(148,163,184,.2); border: 1px solid rgba(148,163,184,.35); }
    .subtitle { margin-top: -4px; font-size: 21px; color: #c9d4e1; }
    .chips { display: flex; flex-wrap: wrap; gap: 10px; }
    .chip { font-size: 14px; padding: 7px 11px; border-radius: 999px; background: rgba(71,85,105,.35); border: 1px solid rgba(148,163,184,.25); }
    .panel { margin-top: 6px; flex: 1; border-radius: 18px; background: rgba(15,23,42,.74); border: 1px solid rgba(148,163,184,.2); padding: 22px; }
    .panel h2 { margin: 0 0 14px; font-size: 24px; }
    .grid.two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .card { border-radius: 14px; padding: 16px; background: rgba(30,41,59,.7); border: 1px solid rgba(148,163,184,.2); }
    .card h3 { margin: 0 0 8px; font-size: 19px; }
    .card p { margin: 0 0 12px; font-size: 14px; color: #b9c6d8; }
    .inline-box { font-size: 15px; background: rgba(100,116,139,.28); color: #e9eef5; padding: 8px 12px; border-radius: 10px; display: inline-block; }
    .mock-user { font-size: 28px; font-weight: 700; }
    .note { margin-left: 8px; font-size: 15px; font-weight: 500; background: rgba(100,116,139,.35); color: #e9eef5; padding: 2px 10px; border-radius: 10px; vertical-align: middle; }
    .profile-shell { display: flex; gap: 16px; align-items: center; border-radius: 16px; background: rgba(30,41,59,.64); border: 1px solid rgba(148,163,184,.18); padding: 20px; }
    .avatar { width: 82px; height: 82px; border-radius: 50%; background: linear-gradient(135deg, #0ea5e9, #7c3aed); }
    .profile-meta .name { font-size: 30px; font-weight: 700; }
    .profile-meta .handle { margin-top: 2px; font-size: 26px; color: #b9c6d8; }
    .profile-meta .inline-box { margin-top: 14px; }
    .timeline { display: flex; flex-direction: column; gap: 16px; }
    .tweet { border-radius: 14px; background: rgba(30,41,59,.64); border: 1px solid rgba(148,163,184,.18); padding: 16px; }
    .tweet .row { display: flex; align-items: center; gap: 6px; }
    .tweet .name { font-size: 23px; font-weight: 700; }
    .tweet .verify { color: #38bdf8; font-size: 17px; }
    .tweet p { margin: 10px 0 0; font-size: 20px; color: #d2dceb; }
    .schedule { border-radius: 14px; background: rgba(30,41,59,.64); border: 1px solid rgba(148,163,184,.18); padding: 16px; }
    .schedule-header { color: #c2d0df; margin-bottom: 14px; font-size: 19px; }
    .btn-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
    .btn { padding: 10px 14px; border-radius: 10px; background: rgba(100,116,139,.32); border: 1px solid rgba(148,163,184,.28); font-size: 18px; }
    .options { display: flex; flex-direction: column; gap: 16px; }
    .quota { border-radius: 12px; background: rgba(51,65,85,.5); padding: 14px; font-size: 18px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
    .table { border-radius: 12px; overflow: hidden; border: 1px solid rgba(148,163,184,.22); }
    .tr { display: grid; grid-template-columns: 1.3fr 1fr 2fr .8fr; padding: 10px 12px; background: rgba(30,41,59,.64); border-top: 1px solid rgba(148,163,184,.14); font-size: 16px; }
    .tr.head { background: rgba(51,65,85,.72); font-size: 14px; font-weight: 700; border-top: 0; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand">
        <img alt="XMate icon" src="${logoDataUrl}" />
        <div>
          <h1>${shot.title}</h1>
          <div class="subtitle">${shot.subtitle}</div>
        </div>
      </div>
      <div class="badge">${shot.badge}</div>
    </div>
    <div class="chips">${chips}</div>
    <section class="panel">
      <h2>${shot.panelTitle}</h2>
      ${shot.panelBody}
    </section>
  </div>
</body>
</html>`;
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const logoBuffer = await readFile(path.resolve(projectRoot, "icons", "icon-128.png"));
  const logoDataUrl = `data:image/png;base64,${logoBuffer.toString("base64")}`;

  const browser = await chromium.launch({ headless: true });
  try {
    for (const shot of shots) {
      const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
      await page.setContent(renderHtml(shot, logoDataUrl), { waitUntil: "networkidle" });
      const outputPath = path.resolve(outputDir, shot.file);
      await page.screenshot({ path: outputPath, type: "png" });
      await page.close();
      console.log(`Generated: ${path.relative(projectRoot, outputPath)}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
