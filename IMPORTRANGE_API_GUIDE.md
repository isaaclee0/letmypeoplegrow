# IMPORTRANGE API Guide

This guide explains how to use the IMPORTRANGE API endpoints to integrate your church attendance data with Google Sheets and Excel.

## Overview

The IMPORTRANGE API provides public endpoints that return data in CSV format, making it compatible with Google Sheets' `IMPORTRANGE()` function and Excel's data import features. These endpoints do not require authentication, making them ideal for spreadsheet integration.

## Available Endpoints

### 1. Attendance Data
**Endpoint:** `/api/importrange/attendance`

Returns detailed attendance records including regular attendees and visitors.

**Required Parameters:**
- `gatheringTypeId` - ID of the gathering type

**Optional Parameters:**
- `startDate` - Start date (YYYY-MM-DD format)
- `endDate` - End date (YYYY-MM-DD format)
- `format` - Response format: `csv` (default) or `json`
- `includeVisitors` - Include visitor data: `true` (default) or `false`
- `includeAbsent` - Include absent records: `true` (default) or `false`

**Example URL:**
```
https://your-domain.com/api/importrange/attendance?gatheringTypeId=1&startDate=2024-01-01&endDate=2024-12-31
```

**CSV Output Columns:**
- Date
- Gathering Type
- First Name
- Last Name
- Family
- Status (Present/Absent/Visitor)
- Recorded At

### 2. Individuals Data
**Endpoint:** `/api/importrange/individuals`

Returns information about all individuals in the system.

**Optional Parameters:**
- `gatheringTypeId` - Filter by gathering type ID
- `format` - Response format: `csv` (default) or `json`
- `includeInactive` - Include inactive individuals: `true` or `false` (default)

**Example URL:**
```
https://your-domain.com/api/importrange/individuals?gatheringTypeId=1
```

**CSV Output Columns:**
- First Name
- Last Name
- Family
- Gathering Type
- Active
- Created At
- Updated At

### 3. Families Data
**Endpoint:** `/api/importrange/families`

Returns information about families and their member counts.

**Optional Parameters:**
- `gatheringTypeId` - Filter by gathering type ID
- `format` - Response format: `csv` (default) or `json`

**Example URL:**
```
https://your-domain.com/api/importrange/families?gatheringTypeId=1
```

**CSV Output Columns:**
- Family Name
- Gathering Type
- Member Count
- Created At
- Updated At

### 4. Summary Statistics
**Endpoint:** `/api/importrange/summary`

Returns daily attendance summaries with counts.

**Optional Parameters:**
- `gatheringTypeId` - Filter by gathering type ID
- `startDate` - Start date (YYYY-MM-DD format)
- `endDate` - End date (YYYY-MM-DD format)
- `format` - Response format: `csv` (default) or `json`

**Example URL:**
```
https://your-domain.com/api/importrange/summary?gatheringTypeId=1&startDate=2024-01-01&endDate=2024-12-31
```

**CSV Output Columns:**
- Date
- Gathering Type
- Present Count
- Absent Count
- Visitor Count
- Total Attendance

## Google Sheets Integration

### Using IMPORTRANGE Function

1. **Basic Usage:**
   ```excel
   =IMPORTRANGE("https://your-domain.com/api/importrange/attendance?gatheringTypeId=1", "attendance")
   ```

2. **With Date Filters:**
   ```excel
   =IMPORTRANGE("https://your-domain.com/api/importrange/attendance?gatheringTypeId=1&startDate=2024-01-01&endDate=2024-12-31", "attendance")
   ```

3. **Summary Data:**
   ```excel
   =IMPORTRANGE("https://your-domain.com/api/importrange/summary?gatheringTypeId=1", "summary")
   ```

### Setting Up in Google Sheets

1. Open Google Sheets
2. In a cell, enter the IMPORTRANGE function
3. Google Sheets will prompt you to authorize the connection
4. Click "Allow access"
5. The data will automatically populate

### Tips for Google Sheets

- **Auto-refresh:** Data refreshes automatically when the sheet is opened
- **Manual refresh:** Use `Ctrl+Shift+R` (Windows) or `Cmd+Shift+R` (Mac)
- **Multiple sheets:** Create separate sheets for different data types
- **Charts:** Use the imported data to create charts and graphs

## Excel Integration

### Method 1: Data > From Web

1. Open Excel
2. Go to **Data** tab
3. Click **From Web**
4. Enter the API URL (e.g., `https://your-domain.com/api/importrange/attendance?gatheringTypeId=1`)
5. Click **OK**
6. Excel will import the CSV data

### Method 2: Power Query

1. Go to **Data** > **Get Data** > **From Web**
2. Enter the API URL
3. Click **OK**
4. In Power Query Editor, ensure the data is formatted correctly
5. Click **Load**

### Method 3: VBA Macro

```vba
Sub ImportAttendanceData()
    Dim url As String
    url = "https://your-domain.com/api/importrange/attendance?gatheringTypeId=1"
    
    With ActiveSheet.QueryTables.Add(Connection:="URL;" & url, Destination:=Range("A1"))
        .WebSelectionType = xlSpecifiedTables
        .WebFormatting = xlWebFormattingNone
        .Refresh BackgroundQuery:=False
    End With
End Sub
```

## Finding Your Gathering Type ID

To find the correct `gatheringTypeId` for your endpoints:

1. **Check the Database:**
   ```sql
   SELECT id, name FROM gathering_types;
   ```

2. **Use the Help Endpoint:**
   Visit `/api/importrange/help` to see available options

3. **Check the Web Interface:**
   Look at the URL when viewing attendance for a specific gathering type

## Security Considerations

- These endpoints are **public** and do not require authentication
- They only return data, no modifications are possible
- Consider implementing rate limiting if needed
- Monitor usage to ensure appropriate access patterns

## Troubleshooting

### Common Issues

1. **"No data returned"**
   - Check if the `gatheringTypeId` is correct
   - Verify date formats (YYYY-MM-DD)
   - Ensure there's data for the specified date range

2. **"Access denied" in Google Sheets**
   - Make sure the URL is accessible from the internet
   - Check if your server allows CORS requests
   - Verify the domain is trusted

3. **"Invalid format" errors**
   - Ensure all parameters are properly URL-encoded
   - Check that date parameters use YYYY-MM-DD format
   - Verify boolean parameters are `true` or `false`

### Testing Endpoints

1. **Test in Browser:**
   Open the API URL directly in a web browser to see the CSV output

2. **Test with curl:**
   ```bash
   curl "https://your-domain.com/api/importrange/attendance?gatheringTypeId=1"
   ```

3. **Check Response Headers:**
   Ensure `Content-Type: text/csv` is returned

## Advanced Usage

### Creating Dynamic URLs

You can create dynamic URLs using cell references in Google Sheets:

```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/attendance?gatheringTypeId=" & A1 & "&startDate=" & B1, "attendance")
```

Where:
- A1 contains the gathering type ID
- B1 contains the start date

### Combining Multiple Data Sources

Create multiple IMPORTRANGE functions to combine different data types:

```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/summary?gatheringTypeId=1", "summary")
=IMPORTRANGE("https://your-domain.com/api/importrange/individuals?gatheringTypeId=1", "individuals")
```

### Creating Dashboards

Use the imported data to create comprehensive dashboards:

1. **Attendance Trends:** Use summary data with charts
2. **Member Lists:** Use individuals data for contact lists
3. **Family Reports:** Use families data for family-based analysis
4. **Custom Calculations:** Combine multiple data sources for custom metrics

## Support

For technical support or questions about the IMPORTRANGE API:

1. Check the help endpoint: `/api/importrange/help`
2. Review server logs for error details
3. Test endpoints directly in a browser
4. Verify database connectivity and data availability 