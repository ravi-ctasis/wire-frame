# RugOS / ExportOS — Enterprise Interactive Wireframe Prototype & SOW Specifications

> **Commerce, Export, Warehouse, Finance & SaaS Platform**  
> **Prepared by:** Ctas Info Services LLP  
> **Original SOW Date:** 07/09/2026  
> **Total SOW Scope:** 9 Modules • 1,645 Estimated Hours • 12 Weeks Delivery Timeline

---

## 🌟 Overview & Architecture

**RugOS / ExportOS** is an end-to-end centralized operating system for handcrafted and commercial rug manufacturers, exporters, and multi-channel retailers operating across **Amazon US, Etsy, Walmart, and B2B wholesale export container shipments**.

This interactive wireframe prototype covers **100% of the SOW scope across all 9 modules**, featuring authentic industry data (New Zealand Wool, Ghazni Wool, Jute flatweaves, Bhadohi/Mirzapur loom units, USA 3PL distribution centers, FedEx international air priority, and DGFT bank realization).

---

## 🚀 How to Launch and Experience the Wireframe

You can run the wireframe directly using any local web server or open `wireframe/index.html` directly in any web browser:

```bash
# Option 1: Python HTTP Server (Port 8080 or any port)
python3 -m http.server 8080

# Then open in browser:
# http://localhost:8080/wireframe/
```

---

## 📋 Comprehensive SOW Scope & Screen Mapping

| SOW Module # | SOW Module Name | Hours | Core Features & Wireframe Screens |
| :--- | :--- | :--- | :--- |
| **Module 1** | Technical Architecture & Foundation | 50 hrs | React/NestJS foundation, MongoDB replica set, Redis background queue monitor, S3 cloud asset storage, secrets management, environment switch (DEV, STAGING/UAT, PROD). |
| **Module 2** | User, Roles & Product/SKU Master | 210 hrs | 7-Role Granular RBAC Matrix (India WH, USA WH, Logistics, Accounts, Management, Auditor), Product Hierarchy, SKU Master Details (dimensions, GSM, construction, costs), Multi-channel mapping (ASIN, Etsy, Walmart), Bulk CSV import/export, and Complete Chronological SKU History Ledger. |
| **Module 3** | Unified Orders & Core Inventory | 240 hrs | Multi-channel order pipeline, mapping exceptions resolver, warehouse allocation selector (India vs USA 3PL), concurrency-safe reservation, USA Physical Receipt Rule enforcement, stock transfers, and reconciliation. |
| **Module 4** | Made-to-Order (MTO), Packing & Replenishment | 270 hrs | Lightweight 4-Stage MTO Kanban (`To Make` $\rightarrow$ `In Production` $\rightarrow$ `QC` $\rightarrow$ `Ready to Pack`), Packing Station with Barcode Scan, **Proof of Packing Photographic Capture**, USA 3PL Inbound QC & Bin put-away, and India $\rightarrow$ USA Replenishment with landed freight allocation. |
| **Module 5** | Shipping, Courier Tracking & Export Docs | 180 hrs | Live FedEx integration, volumetric vs actual weight engine, automated AWB & label generation, real-time tracking events, RTO handling, and Export Documentation Suite (Commercial Invoice, Packing List, Shipping Bill, Certificate of Origin). |
| **Module 6** | Returns, Courier Audit & B2B Receivables / EBRC | 285 hrs | RMA return management, condition grading (resalable/damaged/repairable), tentative carrier claims, **3-Way Courier Invoice Audit Engine** (weight/rate variance, dispute logging, credit notes), B2B receivables aging (0-30, 31-60, 61-90+ days), and Bank FIRA / EBRC export realization. |
| **Module 7** | True Cost, Profitability & Reports | 210 hrs | Multi-tier cost waterfall per order & SKU (Mfg cost, packaging, ocean freight, courier, Amazon fees, 3PL pick/pack), automatic replacement of estimated costs with audited actuals, multi-dimensional profitability, and CSV/Excel/PDF reports. |
| **Module 8** | Dashboard, Analytics & Automation | 160 hrs | Executive Command Center, channel sales radar, inventory position heatmap, replenishment demand forecasting, operational threshold alerts, and scheduled background sync jobs. |
| **Module 9** | QA, UAT & Production Deployment | 40 hrs | Complete 10-Step Interactive End-to-End Operational Lifecycle Simulator, UAT acceptance test checklist, regression test matrix, and production deployment verification. |
| **Total** | **All 9 SOW Modules** | **1,645 hrs** | **100% Comprehensive Coverage** |

---

## 🎯 Special Interactive Features Built-In

1. **Role Switcher Engine**:
   - Switch between **Super Admin / Management, India Warehouse Manager, USA 3PL Warehouse, Logistics & Export Lead, Accounts & Finance Lead, and Statutory Auditor** from the top header to view how screens adapt per persona.

2. **Blueprint Spec Mode**:
   - Toggle the **"Blueprint Spec Mode"** switch in the top header to reveal inline engineering specifications, database models, SOW hours, and acceptance criteria on every single screen.

3. **Full SOW Document Reader**:
   - Click **"📖 View SOW Docs"** in the top navigation or dashboard to inspect the full original SOW scope, delivery timeline, and module breakdown with direct links to every screen.

4. **Proof of Packing Camera Simulator**:
   - Click **"📸 Snap Packing Proof"** on the Packing Station screen to simulate capturing live photos of rug pile condition, desiccant pouch, and polywrap barcode labels before shipment sealing.

5. **Export Document Paper Previewer**:
   - View authentic paper-formatted **Commercial Invoices** and **Bank Foreign Inward Remittance Advice (FIRA / EBRC)** documents ready for customs and bank submission.

6. **3-Way Courier Invoice Audit & Dispute Engine**:
   - Review how the system catches 5.0 kg volumetric catch-weight overbilling on FedEx shipments and allows finance teams to file immediate billing disputes.

7. **End-to-End Operational Lifecycle Simulator**:
   - Click **"⚡ Run E2E Sim"** in the top header to step through a guided 10-step interactive simulation tracing an Amazon order from checkout all the way to final bank export realization.
