import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { notificationRulesAPI } from '../services/api';

interface Rule {
  id: number;
  rule_name: string;
  // add other fields
}

const NotificationRulesPage = () => {
  const [rules, setRules] = useState<Rule[]>([]);
  const [form] = useState({ rule_name: '', target_group: 'regular_attendees', trigger_event: 'misses', threshold_count: 3, timeframe_periods: 1, gathering_type_id: null });

  useEffect(() => {
    loadRules();
  }, []);

  const loadRules = async () => {
    const response = await notificationRulesAPI.getAll();
    setRules(response.data.rules);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await notificationRulesAPI.create(form);
    loadRules();
  };

  // Add update and delete functions similarly

  return (
    <div>
      <h1>Notification Rules</h1>
      <form onSubmit={handleSubmit}>
        {/* Form fields for rule */}
        <button type="submit">Create Rule</button>
      </form>
      <ul>
        {rules.map(rule => <li key={rule.id}>{rule.rule_name}</li>)}
      </ul>
    </div>
  );
};

export default NotificationRulesPage; 