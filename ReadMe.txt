---
## Web App Specification: Church Attendance Tracker

This document outlines the functional requirements and user experience (UX) design for a web application to track church attendance. The focus is on a **user-first approach**, streamlining attendance recording, providing actionable insights, and ensuring data privacy.

---

### I. Core Application Flow & Features

**A. User Authentication & Access Control**

* **Login Method:** Email-based One-Time Code (OTC) system.
    * User enters their email address.
    * System sends a unique, time-sensitive code to that email.
    * User enters the received code to log in.
    * Provide a "Resend Code" option with a clear cooldown period to prevent abuse.
    * **No Stored Passwords:** User credentials will not be persistently stored on the server for enhanced security.
* **User Roles:** Three distinct access levels for granular control:
    * **Administrator (Admin):** Full control over all system features, settings, user management, and reporting.
    * **Coordinator:** Manages specific gatherings and individuals, sets up notifications, and views comprehensive reports for their assigned areas.
    * **Attendance Taker:** Solely focused on recording attendance for assigned gatherings, adding visitors, and accessing recent visitor lists.
* **Role Assignment:** Admins assign roles to users. A user can hold only one role at a time.

**B. Gathering Management**

* **Definition:** A "Gathering" is any event for which attendance is recorded (e.g., Sunday Service, Youth Group, Bible Study).
* **Gathering Type Creation:** Admins and Coordinators can define and manage different types of gatherings.
* **Attendance Lists:** Each gathering type has its own distinct, manageable attendance list.
* **CSV Upload for Initial Lists:**
    * Allows bulk import of names to pre-populate attendance lists.
    * CSV format should include columns for `First Name`, `Last Name`, and a `Family Identifier`.
    * **Data Validation:** System performs basic validation (e.g., ensuring required fields are present, format consistency) during upload.
* **Data Structure Implication:** Each `Gathering` record will have a relationship to its `AttendanceList`, which is a collection of `Individuals` who are considered "regulars" for that gathering type.

**C. Family Management**

* **Core Concept:** The ability to group individuals into "Families" for streamlined attendance check-off.
* **Individual-to-Family Association:** An `Individual` can be linked to one `Family` or remain unassigned.
* **Management (Admins & Coordinators):**
    * Create new `Family` records.
    * Add existing `Individuals` to `Families`.
    * Remove `Individuals` from `Families`.
    * Delete `Families` (un-associating all members).
* **Family Identifier:** Internally, each `Family` will have a unique system-generated ID. A user-friendly "Family Name" (e.g., "The Smith Family") will be used for display. This decouples family grouping from shared surnames.

**D. Attendance Tracking**

* **Date Selection:** User selects the specific date for which attendance is being recorded via a clear date picker.
* **Attendance List Display:**
    * **Default Sort:** Alphabetical by `Last Name`, then `First Name`.
    * **Family Indication:** Visually indicate family members (e.g., a small family icon or the family name next to an individual's name).
    * **UI for Check-off:** Each `Individual` will have a prominent checkbox or toggle to mark their presence.
* **Family Check-off:** For `Families` with members on the current list, a dedicated, easily accessible button (e.g., "Check all for [Family Name]") will appear. Clicking it marks all family members present.
* **Adding Visitors (Floating Action Button - FAB):**
    * A prominent floating `+` button in the bottom-right of the screen will trigger the "Add Visitor" dialogue.
    * **Flexible Naming:** Allows entry of `Full Name`, `Partial Name` (e.g., "Visitor 1"), or even just a numerical count for a group if individual names aren't practical.
    * **Visitor Type Designation:** Required field when adding a visitor:
        * **"Potential Regular":** Individuals or families who may become regular attendees. These are included in follow-up notifications.
        * **"Temporary/Other":** Visitors who are unlikely to become regulars (e.g., guest speaker, tourist). These are counted for total attendance but excluded from specific follow-up notifications.
    * **Visitor Family Designation:** Allows linking multiple visitors to a temporary "Visitor Family" for the current attendance record only (not a permanent family record).
* **Recent Visitors List:**
    * Accessible from the "Add Visitor" dialogue or a dedicated quick-add section.
    * Displays visitors who attended the *same gathering type* within the *last 2 months*.
    * Provides a quick way to re-add returning visitors by selecting them from the list.

**E. UI Navigation for Multiple Gatherings**

* **Context Switching:** If a user is assigned to multiple `Gathering Types`, they need a clear way to switch between them.
* **Recommended UX:** A **floating dropdown/drop-up menu at the bottom-center or top-center of the screen**. This keeps the main attendance list uncluttered. The current `Gathering Type` should be prominently displayed (e.g., "Sunday Service ▼"). Tapping it reveals a list of other accessible `Gathering Types`. A hamburger menu (top-left) can serve as an alternative access point for `Gathering Type` switching and general settings.

**F. Reporting & Analytics**

* **Dedicated "Reports" Section:** Accessible from the main navigation for Admins and Coordinators.
* **General Overview Dashboard (Default):**
    * **Default Period:** Displays key metrics for the last **4 weeks**.
    * **Customizable Periods:** Users can select predefined date ranges (e.g., last 8 weeks, last 3 months, last 6 months, year-to-date) or custom date ranges using a date picker.
    * **Filtering:** All reports can be filtered by `Gathering Type`.
    * **Key Metrics Display:**
        * **Total Attendance Trend:** A line graph showing total attendance over the selected period, with clear differentiation (e.g., stacked areas or separate lines) for `Regular Attendees` vs. `Visitors`.
        * **Regularity Trend:** Average number of meetings `Regular Attendees` participate in per 4-week period, displayed as a numerical average or simple bar chart.
        * **First-Time "Potential Regular" Visitors:** A count of new `Potential Regular` visitors within the selected period.
        * **"Potential Regular" to Regular Ratio:** Calculates `(Count of Potential Regular Visitors over 12 months) / (Average Number of Regular Attendees over 12 months)`. Display as a ratio or percentage. Allow Admins to set a benchmark (default: 1 visitor per 1 regular per year) and show deviation from it.
        * **Visitor "Bounce" Rate:** Percentage of `Potential Regular` visitors who attended only once within a defined look-back period (e.g., last 3 months) and have not returned for the same `Gathering Type`.
    * **Drill-down:** Clicking on data points in graphs or summary numbers should lead to a detailed list of individuals for that specific metric/period.
* **Detailed Attendance Lists:** View and export comprehensive attendance records for any chosen date and `Gathering Type`, including all `Regular Attendees` and `Visitor` details.

**G. Data Export & Integration**

* **CSV Export:** All raw attendance data and generated reports should be exportable as CSV files.
* **Google Sheets Integration (Recommended):**
    * **Mechanism:** Explore direct integration via Google Sheets API (if allowed/feasible for free apps) or provide clear instructions/template for users to set up a Zapier-like integration using webhooks.
    * **Goal:** Allow automated or semi-automated syncing of attendance data to a designated Google Sheet for external analysis or dashboarding.

---

### II. Notification System

**A. Core Functionality**

* **Automated Alerts:** System-generated notifications based on defined rules.
* **Target Users:** Admins and Coordinators receive notifications.
* **Notification Types:**
    * **In-App Notifications:** Displayed in a dedicated notification area (e.g., a bell icon with a badge count in the header, opening to a dropdown/notification center).
    * **Email Notifications:** Sent to the user's registered email address.
* **Clear & Actionable Content:** Notifications should be concise, informative, and include direct links to relevant app sections for follow-up (e.g., "Visitor 'Smith Family' attended 3 times. [View Details]").

**B. Notification Rule Management (Admins & Coordinators)**

* **Default Rules:** Admins configure system-wide default rules.
* **Customizable Rules (Coordinators):** Coordinators can enable/disable default rules and create new rules specific to their needs, within system-defined parameters.
* **Rule Parameters (Simple Logic):**
    * **Target Group:** `Regular Attendees` OR `Potential Regular` `Visitors`.
    * **Trigger Event:** `Attends` OR `Misses`.
    * **Threshold:** `X` (numerical count of attendances or absences).
    * **Timeframe:** `Y` number of *4-week periods* (e.g., "in the last 1 four-week period").
* **Example Rules:**
    * "Notify if a 'Potential Regular' `Visitor` `Attends` `3` times in the last `1` four-week period."
    * "Notify if a `Regular Attendee` `Misses` `2` gatherings in a row."
* **Notification Delivery Preferences (User-Configurable):**
    * Users can select their preferred delivery method(s) (in-app, email).
    * Users can set email frequency (e.g., instant, daily digest, weekly digest).

---

### III. System Administration (Admin Only)

* **User Management:** Create, edit, suspend, and delete user accounts. Assign user roles.
* **System Settings:** Configure global application parameters, default reporting periods, notification benchmarks (e.g., visitor ratio), and integration settings.
* **Data Audit Log (Consideration):** A basic log of significant actions (e.g., user login, attendance list uploads, major data deletions) for accountability.

---

### Decisions Made for Best UX:

1.  **Login:** Opted for email-based One-Time Code (OTC) over traditional passwords for enhanced security and simplified user experience (no password to remember or forget).
2.  **Gathering Navigation:** A floating dropdown/drop-up menu for switching between `Gathering Types` provides quick, context-aware access without cluttering the main attendance screen. A hamburger menu supplements this for broader navigation.
3.  **Visitor Naming:** Provides flexibility for recording `Visitor` names, acknowledging that full names aren't always available, while still allowing for family grouping and tracking.
4.  **Visitor Types:** Introduces explicit "Potential Regular" vs. "Temporary/Other" `Visitor` types at the point of entry. This is crucial for filtering relevant data for notifications and reporting, avoiding false positives for follow-up.
5.  **Recent Visitors Scope:** Limited to "same gathering type" and "last 2 months" to provide a highly relevant and manageable list for quick re-addition, preventing overwhelming the user with irrelevant past visitors.
6.  **"Month" Definition for Notifications:** Standardized as "4-week period" to align with consistent attendance patterns, rather than variable calendar months, for more precise rule triggering.
7.  **Notification UI:** A common bell icon with a badge count for in-app notifications provides a clear, unobtrusive indicator of new alerts.
8.  **Reporting Defaults:** Provides immediate, actionable insights with a "last 4 weeks" default view, ensuring users don't have to configure settings just to see basic trends. The inclusion of "Potential Regular to Regular Ratio" and "Bounce Rate" offers crucial strategic metrics.

---