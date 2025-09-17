# IMPORTRANGE API Usage Examples

This file contains practical examples of how to use the IMPORTRANGE API endpoints with Google Sheets and Excel.

## Google Sheets Examples

### 1. Basic Attendance Data Import

```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/attendance?gatheringTypeId=1", "attendance")
```

This will import all attendance data for gathering type ID 1.

### 2. Attendance Data with Date Range

```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/attendance?gatheringTypeId=1&startDate=2024-01-01&endDate=2024-12-31", "attendance")
```

This will import attendance data for a specific date range.

### 3. Only Present Attendees

```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/attendance?gatheringTypeId=1&includeAbsent=false", "attendance")
```

This will import only attendees who were present (excludes absent records).

### 4. Individuals List

```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/individuals?gatheringTypeId=1", "individuals")
```

This will import all individuals for a specific gathering type.

### 5. Families Data

```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/families?gatheringTypeId=1", "families")
```

This will import family information with member counts.

### 6. Summary Statistics

```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/summary?gatheringTypeId=1", "summary")
```

This will import daily attendance summaries.

## Excel Examples

### Method 1: Data > From Web

1. Open Excel
2. Go to **Data** tab
3. Click **From Web**
4. Enter one of these URLs:
   - `https://your-domain.com/api/importrange/attendance?gatheringTypeId=1`
   - `https://your-domain.com/api/importrange/individuals?gatheringTypeId=1`
   - `https://your-domain.com/api/importrange/summary?gatheringTypeId=1`
5. Click **OK**
6. Excel will import the CSV data

### Method 2: Power Query

1. Go to **Data** > **Get Data** > **From Web**
2. Enter the API URL
3. Click **OK**
4. In Power Query Editor, ensure the data is formatted correctly
5. Click **Load**

## Advanced Usage Examples

### Dynamic URLs with Cell References

Create a configuration section in your spreadsheet:

| A | B |
|---|---|
| 1 | Gathering Type ID |
| 2 | Start Date |
| 3 | End Date |

Then use these formulas:

```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/attendance?gatheringTypeId=" & A1 & "&startDate=" & A2 & "&endDate=" & A3, "attendance")
```

### Multiple Data Sources

Create separate sheets for different data types:

**Sheet: Attendance**
```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/attendance?gatheringTypeId=1", "attendance")
```

**Sheet: Individuals**
```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/individuals?gatheringTypeId=1", "individuals")
```

**Sheet: Summary**
```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/summary?gatheringTypeId=1", "summary")
```

### Creating Dashboards

Use the imported data to create charts and dashboards:

1. **Attendance Trends Chart:**
   - Use summary data to create line charts showing attendance over time

2. **Family Attendance Analysis:**
   - Use attendance data to create pivot tables by family

3. **Member Lists:**
   - Use individuals data to create contact lists

## Real-World Examples

### Example 1: Weekly Attendance Report

**Setup:**
- Create a sheet with weekly date ranges
- Use dynamic URLs to pull data for each week

**Formula:**
```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/summary?gatheringTypeId=1&startDate=" & A1 & "&endDate=" & B1, "summary")
```

### Example 2: Family Contact List

**Setup:**
- Import individuals data
- Filter by active status
- Sort by family name

**Formula:**
```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/individuals?gatheringTypeId=1&includeInactive=false", "individuals")
```

### Example 3: Monthly Attendance Dashboard

**Setup:**
- Import summary data for the current month
- Create charts showing:
  - Daily attendance trends
  - Present vs. absent ratios
  - Visitor counts

**Formula:**
```excel
=IMPORTRANGE("https://your-domain.com/api/importrange/summary?gatheringTypeId=1&startDate=2024-01-01&endDate=2024-01-31", "summary")
```

## Troubleshooting

### Common Issues and Solutions

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

### Testing Your Setup

1. **Test in Browser:**
   - Open the API URL directly in a web browser
   - You should see CSV data or JSON response

2. **Test with curl:**
   ```bash
   curl "https://your-domain.com/api/importrange/attendance?gatheringTypeId=1"
   ```

3. **Check Response Headers:**
   - Ensure `Content-Type: text/csv` is returned for CSV endpoints

## Security Notes

- These endpoints are **public** and do not require authentication
- They only return data, no modifications are possible
- Consider implementing rate limiting if needed
- Monitor usage to ensure appropriate access patterns

## Support

For technical support:
1. Check the help endpoint: `/api/importrange/help`
2. Review server logs for error details
3. Test endpoints directly in a browser
4. Verify database connectivity and data availability 