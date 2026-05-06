This tool allows you to visualize dependencies between GitLab issues as a graph. It is designed to support planning, refinement, and cross-team coordination.

# MAP TYPES
  # Iteration Map
    Displays issues belonging to one or more iterations
    Ideal for sprint analysis
    Helps identify blockers and time-related dependencies
  # Epic Map
    Displays issues belonging to a specific epic
    Linked external issues are shown in gray
    Ideal for understanding the scope of a feature
    
----------------------------

# MAIN FILTERS
  # Scope
    All → all issues
    Assigned to me → only issues assigned to you
    Created by me → only issues created by you
  # Issue Relation Types
    All → all relationships
    Block / Blocked by → only blocking relationships

This filter is essential for planning, as it limits the view to critical dependencies.

# Scheduling Types
  All → all issues
  Planned only → only issues with planning labels
  
# Out of Scope Issues
  Show → include linked external issues
  Hide → display only issues within the selected scope

In Iteration Map → external = outside the iteration
In Epic Map → external = outside the epic

# Epic (Parent Filter)
  All → show all epics
  Open Epic → hide completed epics (QA Passed)
  None → hide all epics

----------------------------
  
# HOW TO COMBINE FILTERS

# Blocker Analysis (Recommended)
  Issue Relation Types → Block / Blocked by
  Out of Scope → Show

This allows you to see what is blocking the sprint, even outside the iteration or epic.

# Clean View
  Out of Scope → Hide

Displays only what belongs to the selected scope.

# Focus on Planned Work
  Scheduling Types → Planned only

----------------------------

# HOW TO READ THE MAP 

# Nodes (Issues)
  Blue → issue within the selected scope
  Gray → linked external issue
  Green border → closed issue
# Epic / Parent
  Represented as rectangles
  The selected epic is highlighted
# Relationships
  Orange line → blocks / blocked_by
  Dashed line → relates_to

Relationships show how issues depend on each other.

----------------------------

# INTERACTION
  Hover → show issue details
  Double click → open the issue in GitLab
  Scroll → zoom
  Drag → move the map

----------------------------

# PRACTICAL TIPS
  Use Block / Blocked by during planning
  Enable Out of Scope = Show to visualize real dependencies
  Hide epics for a cleaner view
  Use the Epic Map to understand the impact of a feature
