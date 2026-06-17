import { IComponent } from './repairGuides';

export interface IReportData {
  reportId: string;
  date: string;
  deviceName: string;
  deviceType: string;
  confidenceScore: number;
  difficultyScore: number;
  estimatedCost: number;
  successProbability: number;
  components: IComponent[];
  steps: Array<{ stepTitle: string; safetyRisk: string; isCompleted: boolean }>;
}

export const downloadReport = (data: IReportData) => {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Pop-up blocker is preventing report print view. Please allow pop-ups.');
    return;
  }

  // Build styled print layout HTML
  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>RepairAI Copilot - Diagnostic Report - ${data.reportId}</title>
      <style>
        body {
          font-family: 'Segoe UI', Roboto, sans-serif;
          color: #111827;
          line-height: 1.5;
          margin: 40px;
          background: #ffffff;
        }
        .header {
          border-bottom: 2px solid #00f0ff;
          padding-bottom: 20px;
          margin-bottom: 30px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .logo {
          font-size: 26px;
          font-weight: 800;
          color: #111827;
          letter-spacing: -0.5px;
        }
        .logo span {
          color: #8a2be2;
        }
        .report-tag {
          background: #f3f4f6;
          border: 1px solid #e5e7eb;
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
        }
        .grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin-bottom: 35px;
        }
        .card {
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 16px;
          background: #fafafa;
        }
        .card h3 {
          margin-top: 0;
          color: #374151;
          font-size: 16px;
          border-bottom: 1px solid #e5e7eb;
          padding-bottom: 8px;
        }
        .stat-line {
          display: flex;
          justify-content: space-between;
          margin: 8px 0;
          font-size: 14px;
        }
        .stat-val {
          font-weight: 600;
        }
        .components-table, .steps-table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 30px;
        }
        .components-table th, .steps-table th {
          background: #f3f4f6;
          text-align: left;
          padding: 10px;
          font-size: 13px;
          font-weight: 600;
          border-bottom: 2px solid #e5e7eb;
        }
        .components-table td, .steps-table td {
          padding: 10px;
          font-size: 14px;
          border-bottom: 1px solid #e5e7eb;
        }
        .badge {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
        }
        .badge-success { background: #d1fae5; color: #065f46; }
        .badge-warning { background: #fef3c7; color: #92400e; }
        .badge-danger { background: #fee2e2; color: #991b1b; }
        .badge-info { background: #dbeafe; color: #1e40af; }
        
        .footer {
          margin-top: 50px;
          border-top: 1px solid #e5e7eb;
          padding-top: 20px;
          font-size: 12px;
          text-align: center;
          color: #6b7280;
        }
        .maintenance-box {
          background: #eff6ff;
          border-left: 4px solid #1d4ed8;
          padding: 15px;
          border-radius: 0 8px 8px 0;
          margin-bottom: 30px;
        }
        .maintenance-box h4 {
          margin: 0 0 8px 0;
          color: #1e3a8a;
        }
        .maintenance-box p {
          margin: 0;
          font-size: 13.5px;
          color: #1e40af;
        }
        @media print {
          .no-print { display: none; }
          body { margin: 20px; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="logo">RepairAI<span>Copilot</span></div>
        <div class="report-tag">Report: ${data.reportId}</div>
      </div>

      <div class="grid">
        <div class="card">
          <h3>Diagnostic Session Info</h3>
          <div class="stat-line">
            <span>Date Generated:</span>
            <span class="stat-val">${data.date}</span>
          </div>
          <div class="stat-line">
            <span>Device Model:</span>
            <span class="stat-val">${data.deviceName}</span>
          </div>
          <div class="stat-line">
            <span>Device Category:</span>
            <span class="stat-val">${data.deviceType}</span>
          </div>
          <div class="stat-line">
            <span>Visual Detection Confidence:</span>
            <span class="stat-val">${data.confidenceScore}%</span>
          </div>
        </div>

        <div class="card">
          <h3>Complexity & Safety Estimations</h3>
          <div class="stat-line">
            <span>Repair Difficulty Rating:</span>
            <span class="stat-val">${data.difficultyScore}/100</span>
          </div>
          <div class="stat-line">
            <span>Estimated Spare Parts Cost:</span>
            <span class="stat-val">$${data.estimatedCost.toFixed(2)}</span>
          </div>
          <div class="stat-line">
            <span>AI Predicted Success Chance:</span>
            <span class="stat-val">${data.successProbability}%</span>
          </div>
        </div>
      </div>

      <h3>Observed Components Inventory</h3>
      <table class="components-table">
        <thead>
          <tr>
            <th>Component Item</th>
            <th>Confidence Score</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${data.components.map(c => `
            <tr>
              <td><strong>${c.name}</strong></td>
              <td>${(c.confidence * 100).toFixed(1)}%</td>
              <td><span class="badge badge-info">Identified</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <h3>Repair Instructions & Checklist Progress</h3>
      <table class="steps-table">
        <thead>
          <tr>
            <th>Step Index</th>
            <th>Action Instruction Detail</th>
            <th>Hazard level</th>
            <th>Completion Status</th>
          </tr>
        </thead>
        <tbody>
          ${data.steps.map((s, idx) => `
            <tr>
              <td>${idx + 1}</td>
              <td>${s.stepTitle}</td>
              <td>
                <span class="badge ${
                  s.safetyRisk === 'high' ? 'badge-danger' : 
                  s.safetyRisk === 'medium' ? 'badge-warning' : 'badge-success'
                }">${s.safetyRisk.toUpperCase()}</span>
              </td>
              <td>
                <span class="badge ${s.isCompleted ? 'badge-success' : 'badge-warning'}">
                  ${s.isCompleted ? 'Completed' : 'Skipped / Incomplete'}
                </span>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div class="maintenance-box">
        <h4>Preventive Maintenance Suggestions</h4>
        <p>
          To avoid similar hardware issues, clean motherboard dust periodically using dry compressed air, replace thermal paste every 2 years, secure loose cables inside panel brackets, and shut down power adapters when the device remains idle for extended periods.
        </p>
      </div>

      <div class="no-print" style="margin-top: 40px; text-align: right;">
        <button onclick="window.print()" style="background: #00f0ff; color: #000; font-weight: 700; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 14px; box-shadow: 0 4px 6px rgba(0, 240, 255, 0.2);">
          Print / Save PDF Report
        </button>
      </div>

      <div class="footer">
        © ${new Date().getFullYear()} RepairAI Copilot - AI-Assisted Device Hardware Diagnosis. Made for hackathon presentation.
      </div>
    </body>
    </html>
  `;

  printWindow.document.write(htmlContent);
  printWindow.document.close();
};
