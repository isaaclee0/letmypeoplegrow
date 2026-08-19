import React from 'react';

export type ReportTabKey = 'selected-period' | 'long-term-health' | 'pastoral-care';

interface ReportTabsProps {
  activeTab: ReportTabKey;
  onChange: (tab: ReportTabKey) => void;
}

const tabs: Array<{ key: ReportTabKey; label: string }> = [
  { key: 'selected-period', label: 'Selected period' },
  { key: 'long-term-health', label: 'Long-term health' },
  { key: 'pastoral-care', label: 'Pastoral care' },
];

const ReportTabs: React.FC<ReportTabsProps> = ({ activeTab, onChange }) => {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;

    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    onChange(nextTab.key);
    document.getElementById(`report-tab-${nextTab.key}`)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Report workspaces"
      className="flex gap-1 overflow-x-auto border-b border-gray-200 px-2 dark:border-gray-700"
    >
      {tabs.map((tab, index) => {
        const selected = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            id={`report-tab-${tab.key}`}
            type="button"
            role="tab"
            aria-controls={`report-panel-${tab.key}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.key)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 ${
              selected
                ? 'border-primary-600 text-primary-700 dark:border-primary-400 dark:text-primary-300'
                : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
};

export default ReportTabs;
