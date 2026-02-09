import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CloudArrowUpIcon,
  CheckCircleIcon,
  XMarkIcon,
  TrashIcon,
  SparklesIcon
} from '@heroicons/react/24/outline';
import api from '../services/api';

interface DataAngelMember {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  mobile?: string;
  isMainContact1: boolean;
  isMainContact2: boolean;
  originalData: Record<string, any>;
}

interface DataAngelFamily {
  id: string;
  suggestedFamilyName: string;
  members: DataAngelMember[];
  confidence: 'high' | 'medium' | 'low';
  isReviewed: boolean;
  isConfirmed: boolean;
}

type Step = 'upload' | 'processing' | 'review' | 'confirm' | 'importing' | 'complete';

const DataAngelImportPage: React.FC = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [families, setFamilies] = useState<DataAngelFamily[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [filter, setFilter] = useState<'all' | 'needs-review' | 'confirmed'>('all');
  const [error, setError] = useState<string | null>(null);

  // Handle file selection
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setError(null);
    }
  };

  // Handle file upload and processing
  const handleUpload = async () => {
    if (!file) return;

    setStep('processing');
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await api.post('/api/dataangel/process', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });

      setFamilies(response.data.families);
      setStats(response.data.stats);
      setStep('review');
    } catch (err: any) {
      console.error('Upload error:', err);
      setError(err.response?.data?.error || 'Failed to process file');
      setStep('upload');
    }
  };

  // Toggle main contact status
  const toggleMainContact = (familyId: string, memberId: string) => {
    setFamilies(families.map(family => {
      if (family.id !== familyId) return family;

      return {
        ...family,
        members: family.members.map(member => {
          if (member.id !== memberId) {
            // Keep other members as-is
            return member;
          }

          // Toggle cycle: none → MC1 → MC2 → none
          if (!member.isMainContact1 && !member.isMainContact2) {
            // Currently not a main contact → Set as MC1
            // Remove MC1 from others
            family.members.forEach(m => {
              if (m.id !== memberId && m.isMainContact1) {
                m.isMainContact1 = false;
              }
            });
            return { ...member, isMainContact1: true, isMainContact2: false };
          } else if (member.isMainContact1) {
            // Currently MC1 → Set as MC2
            // Remove MC2 from others
            family.members.forEach(m => {
              if (m.id !== memberId && m.isMainContact2) {
                m.isMainContact2 = false;
              }
            });
            return { ...member, isMainContact1: false, isMainContact2: true };
          } else {
            // Currently MC2 → Remove main contact status
            return { ...member, isMainContact1: false, isMainContact2: false };
          }
        })
      };
    }));
  };

  // Remove member from family
  const removeMember = (familyId: string, memberId: string) => {
    if (!window.confirm('Remove this person from the family?')) return;

    setFamilies(families.map(family => {
      if (family.id !== familyId) return family;
      return {
        ...family,
        members: family.members.filter(m => m.id !== memberId)
      };
    }).filter(family => family.members.length > 0)); // Remove empty families
  };

  // Confirm a single family
  const confirmFamily = (familyId: string) => {
    setFamilies(families.map(family => {
      if (family.id !== familyId) return family;
      return { ...family, isConfirmed: true, isReviewed: true };
    }));
  };

  // Confirm all families
  const confirmAllFamilies = () => {
    setStep('confirm');
  };

  // Import all families
  const handleImport = async () => {
    setStep('importing');
    setError(null);

    try {
      await api.post('/api/dataangel/import', { families });
      setStep('complete');
    } catch (err: any) {
      console.error('Import error:', err);
      setError(err.response?.data?.error || 'Failed to import families');
      setStep('confirm');
    }
  };

  // Filter families
  const filteredFamilies = families.filter(family => {
    if (filter === 'needs-review') return family.confidence === 'low' || family.confidence === 'medium';
    if (filter === 'confirmed') return family.isConfirmed;
    return true;
  });

  // Confidence badge
  const ConfidenceBadge: React.FC<{ confidence: string }> = ({ confidence }) => {
    const colors = {
      high: 'bg-green-100 text-green-800',
      medium: 'bg-yellow-100 text-yellow-800',
      low: 'bg-red-100 text-red-800'
    };

    const icons = {
      high: '🟢',
      medium: '🟡',
      low: '🔴'
    };

    const labels = {
      high: 'High confidence',
      medium: 'Please review',
      low: 'Needs your input'
    };

    return (
      <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${colors[confidence as keyof typeof colors]}`}>
        {icons[confidence as keyof typeof icons]} {labels[confidence as keyof typeof labels]}
      </span>
    );
  };

  // Family Card Component
  const FamilyCard: React.FC<{ family: DataAngelFamily }> = ({ family }) => {
    const confidenceColors = {
      high: 'border-green-200 bg-green-50',
      medium: 'border-yellow-200 bg-yellow-50',
      low: 'border-red-200 bg-red-50'
    };

    return (
      <div className={`border-2 rounded-lg p-4 ${family.isConfirmed ? 'opacity-75 bg-gray-50' : confidenceColors[family.confidence]}`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold">{family.suggestedFamilyName}</h3>
          {!family.isConfirmed && <ConfidenceBadge confidence={family.confidence} />}
        </div>

        {/* Members */}
        <div className="space-y-2">
          {family.members.map(member => (
            <div key={member.id} className="flex items-start space-x-3 p-2 rounded hover:bg-white/50 group">
              <div
                className="flex-1 cursor-pointer"
                onClick={() => toggleMainContact(family.id, member.id)}
              >
                <div className="flex items-center space-x-2">
                  <span className="font-medium">
                    {member.firstName} {member.lastName}
                  </span>
                  {member.isMainContact1 && (
                    <span className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded">MC1</span>
                  )}
                  {member.isMainContact2 && (
                    <span className="text-xs bg-purple-600 text-white px-2 py-0.5 rounded">MC2</span>
                  )}
                </div>
                {member.email && (
                  <div className="text-xs text-gray-600">{member.email}</div>
                )}
                {member.mobile && (
                  <div className="text-xs text-gray-600">{member.mobile}</div>
                )}
              </div>
              <button
                onClick={() => removeMember(family.id, member.id)}
                className="opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-700 transition-opacity"
                title="Remove from family"
              >
                <TrashIcon className="h-5 w-5" />
              </button>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="mt-4 pt-3 border-t border-gray-200">
          {family.isConfirmed ? (
            <div className="flex items-center text-green-600 text-sm">
              <CheckCircleIcon className="h-5 w-5 mr-2" />
              Confirmed
            </div>
          ) : (
            <button
              onClick={() => confirmFamily(family.id)}
              className="w-full bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700"
            >
              ✓ Looks Good
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center">
            <SparklesIcon className="h-8 w-8 text-purple-500 mr-3" />
            Data Angel
          </h1>
          <p className="text-gray-600 mt-1">AI-powered member import</p>
        </div>
        <button
          onClick={() => navigate('/people')}
          className="text-gray-600 hover:text-gray-900"
        >
          <XMarkIcon className="h-6 w-6" />
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">{error}</p>
        </div>
      )}

      {/* Step: Upload */}
      {step === 'upload' && (
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-lg shadow-md p-8">
            <h2 className="text-xl font-semibold mb-4">Upload Your Member List</h2>
            <p className="text-gray-600 mb-6">
              Upload your member list in any format. Don't worry about formatting - Data Angel will handle it!
            </p>

            {/* File Upload */}
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-purple-500 transition-colors">
              <input
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                className="hidden"
                id="file-upload"
              />
              <label htmlFor="file-upload" className="cursor-pointer">
                <CloudArrowUpIcon className="h-16 w-16 text-gray-400 mx-auto mb-4" />
                <p className="text-lg font-medium text-gray-700 mb-2">
                  {file ? file.name : 'Drop CSV file here or click to browse'}
                </p>
                <p className="text-sm text-gray-500">
                  Supported: Elvanto export, Planning Center export, Excel/Google Sheets, any CSV
                </p>
              </label>
            </div>

            {/* Upload Button */}
            {file && (
              <button
                onClick={handleUpload}
                className="mt-6 w-full bg-purple-600 text-white px-6 py-3 rounded-md hover:bg-purple-700 font-medium"
              >
                Upload and Process →
              </button>
            )}
          </div>
        </div>
      )}

      {/* Step: Processing */}
      {step === 'processing' && (
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-lg shadow-md p-8 text-center">
            <SparklesIcon className="h-16 w-16 text-purple-500 mx-auto mb-4 animate-pulse" />
            <h2 className="text-xl font-semibold mb-4">✨ Data Angel is organizing your members...</h2>
            <div className="w-full bg-gray-200 rounded-full h-3 mb-4">
              <div className="bg-purple-600 h-3 rounded-full animate-pulse" style={{ width: '70%' }}></div>
            </div>
            <p className="text-gray-600">Processing your CSV file...</p>
          </div>
        </div>
      )}

      {/* Step: Review */}
      {step === 'review' && (
        <div>
          {/* Stats */}
          <div className="bg-white rounded-lg shadow-md p-6 mb-6">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-center">
              <div>
                <div className="text-3xl font-bold text-purple-600">{stats?.totalPeople || 0}</div>
                <div className="text-sm text-gray-600">People</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-gray-900">{stats?.totalFamilies || 0}</div>
                <div className="text-sm text-gray-600">Families</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-green-600">{stats?.highConfidence || 0}</div>
                <div className="text-sm text-gray-600">🟢 High</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-yellow-600">{stats?.mediumConfidence || 0}</div>
                <div className="text-sm text-gray-600">🟡 Medium</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-red-600">{stats?.lowConfidence || 0}</div>
                <div className="text-sm text-gray-600">🔴 Low</div>
              </div>
            </div>
          </div>

          {/* Instructions */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
            <p className="text-sm text-blue-800">
              <strong>How to review:</strong> Click names to set Main Contact 1 (first click) and Main Contact 2 (second click).
              Click the trash icon to remove someone from a family.
            </p>
          </div>

          {/* Filter */}
          <div className="flex space-x-2 mb-6">
            <button
              onClick={() => setFilter('all')}
              className={`px-4 py-2 rounded-md ${filter === 'all' ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-700'}`}
            >
              All ({families.length})
            </button>
            <button
              onClick={() => setFilter('needs-review')}
              className={`px-4 py-2 rounded-md ${filter === 'needs-review' ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-700'}`}
            >
              Needs Review ({families.filter(f => f.confidence !== 'high').length})
            </button>
            <button
              onClick={() => setFilter('confirmed')}
              className={`px-4 py-2 rounded-md ${filter === 'confirmed' ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-700'}`}
            >
              Confirmed ({families.filter(f => f.isConfirmed).length})
            </button>
          </div>

          {/* Family Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
            {filteredFamilies.map(family => (
              <FamilyCard key={family.id} family={family} />
            ))}
          </div>

          {/* Action Buttons */}
          <div className="flex justify-between items-center bg-white rounded-lg shadow-md p-6">
            <button
              onClick={() => setStep('upload')}
              className="text-gray-600 hover:text-gray-900"
            >
              ← Back
            </button>
            <button
              onClick={confirmAllFamilies}
              className="bg-purple-600 text-white px-8 py-3 rounded-md hover:bg-purple-700 font-medium"
            >
              Confirm and Import ({families.length} families) →
            </button>
          </div>
        </div>
      )}

      {/* Step: Confirm */}
      {step === 'confirm' && (
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-lg shadow-md p-8">
            <h2 className="text-xl font-semibold mb-4">Import Summary</h2>

            <div className="space-y-4 mb-6">
              <div className="flex items-center text-green-600">
                <CheckCircleIcon className="h-6 w-6 mr-2" />
                <span>{families.length} families ready to import</span>
              </div>
              <div className="flex items-center text-green-600">
                <CheckCircleIcon className="h-6 w-6 mr-2" />
                <span>{families.reduce((sum, f) => sum + f.members.length, 0)} people ready to import</span>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
              <h3 className="font-medium text-blue-900 mb-2">What happens next:</h3>
              <ul className="text-sm text-blue-800 space-y-1">
                <li>• Families and people will be added to your church database</li>
                <li>• Email/SMS invitations will NOT be sent (you can do this later)</li>
                <li>• You can review and edit all members from the People page</li>
              </ul>
            </div>

            <div className="flex space-x-4">
              <button
                onClick={() => setStep('review')}
                className="flex-1 bg-gray-200 text-gray-700 px-6 py-3 rounded-md hover:bg-gray-300"
              >
                ← Back to Review
              </button>
              <button
                onClick={handleImport}
                className="flex-1 bg-purple-600 text-white px-6 py-3 rounded-md hover:bg-purple-700 font-medium"
              >
                Import All Members →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step: Importing */}
      {step === 'importing' && (
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-lg shadow-md p-8 text-center">
            <SparklesIcon className="h-16 w-16 text-purple-500 mx-auto mb-4 animate-pulse" />
            <h2 className="text-xl font-semibold mb-4">Importing your members...</h2>
            <p className="text-gray-600">Please wait while we add your families to the database.</p>
          </div>
        </div>
      )}

      {/* Step: Complete */}
      {step === 'complete' && (
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-lg shadow-md p-8 text-center">
            <CheckCircleIcon className="h-16 w-16 text-green-500 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-green-600 mb-4">Import Complete!</h2>
            <p className="text-gray-600 mb-6">
              Successfully imported {families.length} families and {families.reduce((sum, f) => sum + f.members.length, 0)} people.
            </p>
            <button
              onClick={() => navigate('/people')}
              className="bg-purple-600 text-white px-8 py-3 rounded-md hover:bg-purple-700 font-medium"
            >
              Go to People Page →
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DataAngelImportPage;
